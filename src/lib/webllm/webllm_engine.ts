/**
 * In-browser LLM inference via WebGPU using WebLLM (`@mlc-ai/web-llm`).
 *
 * This module is renderer-only (it touches `navigator.gpu`, IndexedDB and the
 * Cache API). It must NEVER be imported from the Electron main process.
 *
 * Responsibilities:
 *  1. WebGPU feature detection (navigator.gpu + a real adapter).
 *  2. Cache-aware engine initialization with a clear "first download" vs
 *     "load from cache" distinction driven by WebLLM's initProgressCallback.
 *  3. Persistent model caching via IndexedDB so weights survive reloads and
 *     browser sessions, with graceful handling of cache eviction/corruption.
 *  4. Explicit handling of the nasty failure modes: GPU OOM, navigate-away
 *     mid-download, and multi-tab races on the first download.
 *
 * Nothing here renders UI — callers drive their own UI from the
 * {@link WebLLMProgress} callback. That keeps this a drop-in library module and
 * avoids adding routing/state/styling scaffolding to the app.
 */

// WebGPU types aren't in TS 5.9's lib.dom yet and `@webgpu/types` isn't a
// project dependency, so we declare the *minimal* surface we actually use for
// feature detection. This intentionally does NOT redeclare the whole WebGPU API
// — just enough to type the two calls the spec requires.
interface MinimalGPUAdapter {
  readonly features: ReadonlySet<string>;
  requestAdapterInfo?: () => Promise<{ vendor?: string; architecture?: string }>;
}
interface MinimalGPU {
  requestAdapter(options?: {
    powerPreference?: "low-power" | "high-performance";
  }): Promise<MinimalGPUAdapter | null>;
}
function getGPU(): MinimalGPU | undefined {
  return (navigator as unknown as { gpu?: MinimalGPU }).gpu;
}

import {
  CreateMLCEngine,
  hasModelInCache,
  deleteModelInCache,
  prebuiltAppConfig,
  type MLCEngine,
  type AppConfig,
  type InitProgressReport,
} from "@mlc-ai/web-llm";

// ── Model selection ──────────────────────────────────────────────────────────

/**
 * Default model: a 4-bit (q4f16_1) quantized 1B Llama. Quantized + small so it
 * runs on integrated / low-VRAM GPUs. We deliberately do NOT default to
 * full-precision weights.
 */
export const DEFAULT_WEBLLM_MODEL_ID = "Llama-3.2-1B-Instruct-q4f16_1-MLC";

/**
 * Progressively smaller q4f16_1 fallbacks to suggest when the GPU can't fit the
 * selected model. Ordered largest → smallest.
 */
export const SMALLER_MODEL_FALLBACKS: readonly string[] = [
  "Qwen2.5-0.5B-Instruct-q4f16_1-MLC",
  "SmolLM2-360M-Instruct-q4f16_1-MLC",
];

/** Suggest the next-smaller quantized model, or null if none smaller exists. */
export function suggestSmallerModel(currentModelId: string): string | null {
  if (currentModelId === DEFAULT_WEBLLM_MODEL_ID) {
    return SMALLER_MODEL_FALLBACKS[0] ?? null;
  }
  const idx = SMALLER_MODEL_FALLBACKS.indexOf(currentModelId);
  if (idx >= 0 && idx + 1 < SMALLER_MODEL_FALLBACKS.length) {
    return SMALLER_MODEL_FALLBACKS[idx + 1];
  }
  // Unknown / largest model → suggest the top fallback.
  return idx === -1 ? SMALLER_MODEL_FALLBACKS[0] ?? null : null;
}

// ── Feature detection ────────────────────────────────────────────────────────

export type WebGPUSupport =
  | { supported: true; adapterDescription: string }
  | {
      supported: false;
      reason: "no-navigator-gpu" | "no-adapter" | "error";
      message: string;
    };

/**
 * Detect whether WebGPU can actually run models on this device/browser.
 *
 * Per the requirements this does BOTH checks and never silently falls back:
 *  1. `navigator.gpu` must exist.
 *  2. `requestAdapter()` must resolve to a non-null adapter.
 *
 * Returns a structured result so the UI can show a clear, specific "WebGPU
 * unavailable" state instead of a generic error.
 */
export async function detectWebGPU(): Promise<WebGPUSupport> {
  const gpu = getGPU();
  if (!gpu) {
    return {
      supported: false,
      reason: "no-navigator-gpu",
      message:
        "This browser doesn't expose WebGPU (navigator.gpu is missing). " +
        "Use a recent Chromium-based browser, or enable the WebGPU flag.",
    };
  }

  try {
    // Prefer the discrete/high-performance GPU when the device has one.
    const adapter = await gpu.requestAdapter({
      powerPreference: "high-performance",
    });
    if (!adapter) {
      return {
        supported: false,
        reason: "no-adapter",
        message:
          "WebGPU is present but no compatible GPU adapter was returned. " +
          "Your GPU/driver may be blocklisted or hardware acceleration is off.",
      };
    }

    let description = "WebGPU adapter available";
    try {
      const info = await adapter.requestAdapterInfo?.();
      if (info?.vendor || info?.architecture) {
        description = `WebGPU adapter: ${info.vendor ?? "unknown"} ${
          info.architecture ?? ""
        }`.trim();
      }
    } catch {
      // adapterInfo is best-effort; ignore.
    }
    return { supported: true, adapterDescription: description };
  } catch (err) {
    return {
      supported: false,
      reason: "error",
      message: `WebGPU adapter request failed: ${errText(err)}`,
    };
  }
}

// ── Progress model ───────────────────────────────────────────────────────────

export type WebLLMLoadPhase =
  | "checking-support"
  | "checking-cache"
  | "downloading" // first-time load: fetching weights over the network
  | "loading-from-cache" // subsequent load: reading weights from IndexedDB
  | "initializing-gpu" // weights present, compiling shaders / uploading to GPU
  | "ready"
  | "error";

export interface WebLLMProgress {
  phase: WebLLMLoadPhase;
  /** 0..1, taken from WebLLM's initProgressCallback when available. */
  progress: number;
  /** Human-readable status (WebLLM's `report.text` or our own). */
  text: string;
  /**
   * Whether this load is being served from cache (no network download).
   * Decided up-front from the cache probe and refined live from report.text.
   */
  fromCache: boolean;
}

// ── Errors ───────────────────────────────────────────────────────────────────

export class WebGPUUnavailableError extends Error {
  constructor(public readonly detail: Extract<WebGPUSupport, { supported: false }>) {
    super(detail.message);
    this.name = "WebGPUUnavailableError";
  }
}

export class WebLLMOutOfMemoryError extends Error {
  constructor(
    public readonly modelId: string,
    public readonly suggestedModelId: string | null,
    cause?: unknown,
  ) {
    super(
      suggestedModelId
        ? `The GPU ran out of memory loading "${modelId}". Try a smaller quantized model such as "${suggestedModelId}".`
        : `The GPU ran out of memory loading "${modelId}", and no smaller model is available.`,
    );
    this.name = "WebLLMOutOfMemoryError";
    if (cause) (this as { cause?: unknown }).cause = cause;
  }
}

// ── Engine initialization ────────────────────────────────────────────────────

export interface InitWebLLMOptions {
  modelId?: string;
  /** Progress callback that drives the caller's UI. */
  onProgress?: (p: WebLLMProgress) => void;
  /**
   * Abort signal — pass one tied to page/component lifecycle so a navigate-away
   * mid-download can cancel cleanly.
   */
  signal?: AbortSignal;
}

/**
 * Build an AppConfig whose cache backend is IndexedDB so downloaded weights
 * persist across reloads and browser sessions.
 *
 * NOTE: In older WebLLM releases this was `appConfig.useIndexedDBCache: true`.
 * As of the version pinned here (v0.2.x) that boolean was replaced by the typed
 * `cacheBackend` field; `"indexeddb"` is the equivalent, persistent backend.
 */
function buildIndexedDBAppConfig(): AppConfig {
  return {
    ...prebuiltAppConfig,
    cacheBackend: "indexeddb",
  };
}

// One in-flight init per modelId. A second caller (e.g. a second component, or
// this tab racing itself) awaits the same promise instead of kicking off a
// duplicate download.
const inFlightInits = new Map<string, Promise<MLCEngine>>();

/**
 * Initialize a WebLLM engine with feature detection, persistent caching and a
 * cache-aware progress UI.
 *
 * Flow:
 *   1. Feature-detect WebGPU (throws {@link WebGPUUnavailableError} if absent).
 *   2. Probe the cache to decide the initial phase — "loading-from-cache" for
 *      returning users, "downloading" for first-timers — so we never show a
 *      redundant "downloading" state to someone who already has the weights.
 *   3. Load, refining the phase live from the progress callback.
 *   4. On a cache read failure (eviction/corruption) re-download once from a
 *      clean slate. On GPU OOM, throw {@link WebLLMOutOfMemoryError}.
 */
export async function initWebLLMEngine(
  opts: InitWebLLMOptions = {},
): Promise<MLCEngine> {
  const modelId = opts.modelId ?? DEFAULT_WEBLLM_MODEL_ID;

  // Dedupe concurrent inits for the same model within this tab.
  const existing = inFlightInits.get(modelId);
  if (existing) return existing;

  const task = runInit(modelId, opts).finally(() => {
    inFlightInits.delete(modelId);
  });
  inFlightInits.set(modelId, task);
  return task;
}

async function runInit(
  modelId: string,
  opts: InitWebLLMOptions,
): Promise<MLCEngine> {
  const emit = (p: WebLLMProgress) => opts.onProgress?.(p);

  // 1) Feature detection — required, never skipped.
  emit({
    phase: "checking-support",
    progress: 0,
    text: "Checking WebGPU support…",
    fromCache: false,
  });
  const support = await detectWebGPU();
  if (!support.supported) {
    emit({
      phase: "error",
      progress: 0,
      text: support.message,
      fromCache: false,
    });
    throw new WebGPUUnavailableError(support);
  }
  throwIfAborted(opts.signal);

  const appConfig = buildIndexedDBAppConfig();

  // 2) Cache probe. Cache eviction means a `true` here is a *hint*, not a
  //    guarantee — we still guard the actual load below.
  emit({
    phase: "checking-cache",
    progress: 0,
    text: "Checking for a cached copy of the model…",
    fromCache: false,
  });
  let cached = false;
  try {
    cached = await hasModelInCache(modelId, appConfig);
  } catch {
    // If the probe itself fails, assume not cached and download fresh.
    cached = false;
  }
  throwIfAborted(opts.signal);

  // Multi-tab race guard: serialize the *first* download across tabs using the
  // Web Locks API when available, so two tabs opened at once don't both write
  // the same weights into the shared cache concurrently. Cached loads are
  // read-only and safe to run in parallel, so we only take the lock when we
  // actually expect to download.
  if (!cached && typeof navigator !== "undefined" && navigator.locks) {
    return navigator.locks.request(
      `webllm-download:${modelId}`,
      async () => {
        // Another tab may have finished downloading while we waited for the
        // lock — re-probe so we correctly switch to the cached path.
        let nowCached = false;
        try {
          nowCached = await hasModelInCache(modelId, appConfig);
        } catch {
          nowCached = false;
        }
        return loadWithGuards(modelId, appConfig, nowCached, opts, emit);
      },
    );
  }

  return loadWithGuards(modelId, appConfig, cached, opts, emit);
}

/**
 * Perform the actual engine load with cache-corruption recovery and OOM
 * classification. `expectCached` chooses the initial UI phase.
 */
async function loadWithGuards(
  modelId: string,
  appConfig: AppConfig,
  expectCached: boolean,
  opts: InitWebLLMOptions,
  emit: (p: WebLLMProgress) => void,
): Promise<MLCEngine> {
  try {
    return await createEngine(modelId, appConfig, expectCached, opts, emit);
  } catch (err) {
    throwIfAborted(opts.signal);

    // ── Failure mode: GPU OOM ──────────────────────────────────────────────
    if (isOutOfMemoryError(err)) {
      const suggestion = suggestSmallerModel(modelId);
      emit({
        phase: "error",
        progress: 0,
        text: new WebLLMOutOfMemoryError(modelId, suggestion).message,
        fromCache: false,
      });
      throw new WebLLMOutOfMemoryError(modelId, suggestion, err);
    }

    // ── Failure mode: cache eviction / corruption ──────────────────────────
    // If we *expected* a cached copy but the load failed reading it, the cache
    // was likely evicted under disk pressure or left partial by an interrupted
    // download. Wipe this model's cache and re-download ONCE from scratch.
    if (expectCached && isProbablyCacheError(err)) {
      emit({
        phase: "downloading",
        progress: 0,
        text: "Cached model was incomplete — re-downloading…",
        fromCache: false,
      });
      try {
        await deleteModelInCache(modelId, appConfig);
      } catch {
        // best-effort cleanup
      }
      throwIfAborted(opts.signal);
      // Second attempt is explicitly a fresh download (expectCached = false).
      return createEngine(modelId, appConfig, false, opts, emit);
    }

    emit({
      phase: "error",
      progress: 0,
      text: `Failed to initialize model: ${errText(err)}`,
      fromCache: false,
    });
    throw err;
  }
}

async function createEngine(
  modelId: string,
  appConfig: AppConfig,
  expectCached: boolean,
  opts: InitWebLLMOptions,
  emit: (p: WebLLMProgress) => void,
): Promise<MLCEngine> {
  // `fromCache` starts from the cache probe and is refined live below.
  let fromCache = expectCached;

  emit({
    phase: expectCached ? "loading-from-cache" : "downloading",
    progress: 0,
    text: expectCached
      ? "Loading model from cache…"
      : "Downloading model (first-time setup)…",
    fromCache,
  });

  const engine = await CreateMLCEngine(modelId, {
    appConfig,
    initProgressCallback: (report: InitProgressReport) => {
      throwIfAborted(opts.signal);
      const { phase, fromCache: refined } = classifyProgress(
        report,
        expectCached,
      );
      fromCache = refined;
      emit({
        phase,
        progress: report.progress,
        text: report.text,
        fromCache,
      });
    },
  });
  throwIfAborted(opts.signal);

  emit({
    phase: "ready",
    progress: 1,
    text: fromCache
      ? "Model ready (loaded from cache)."
      : "Model ready (downloaded and cached for next time).",
    fromCache,
  });
  return engine;
}

/**
 * Map a WebLLM progress report to our phase + a refined `fromCache` flag.
 *
 * WebLLM's `report.text` reveals which path is actually running:
 *   - "Loading model from cache"  → cached read (no network)
 *   - "Fetching param" / "Downloading" → network download (first load)
 *   - "Loading GPU shader" / "shader modules" → GPU compile/upload stage
 * We start from the up-front cache probe (`expectCached`) and correct it here,
 * because these two paths are exactly what's easy to conflate and silently
 * break caching.
 */
function classifyProgress(
  report: InitProgressReport,
  expectCached: boolean,
): { phase: WebLLMLoadPhase; fromCache: boolean } {
  const t = report.text.toLowerCase();

  if (t.includes("cache")) {
    return { phase: "loading-from-cache", fromCache: true };
  }
  if (t.includes("fetch") || t.includes("download")) {
    return { phase: "downloading", fromCache: false };
  }
  if (t.includes("shader") || t.includes("gpu")) {
    // Weights are resident; this is shader compile / GPU upload.
    return { phase: "initializing-gpu", fromCache: expectCached };
  }
  // Unknown line — keep the phase implied by the cache probe.
  return {
    phase: expectCached ? "loading-from-cache" : "downloading",
    fromCache: expectCached,
  };
}

/**
 * Force a clean re-download of a model's weights. Useful as a "reset" action
 * when a user hits corruption, or to reclaim storage.
 */
export async function resetWebLLMModelCache(
  modelId: string = DEFAULT_WEBLLM_MODEL_ID,
): Promise<void> {
  try {
    await deleteModelInCache(modelId, buildIndexedDBAppConfig());
  } catch {
    // best-effort
  }
}

/** Whether a fully-cached copy of the model is present. */
export async function isWebLLMModelCached(
  modelId: string = DEFAULT_WEBLLM_MODEL_ID,
): Promise<boolean> {
  try {
    return await hasModelInCache(modelId, buildIndexedDBAppConfig());
  } catch {
    return false;
  }
}

// ── Error classification helpers ─────────────────────────────────────────────

function errText(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return String(err);
  } catch {
    return "unknown error";
  }
}

function isOutOfMemoryError(err: unknown): boolean {
  const m = errText(err).toLowerCase();
  return (
    m.includes("out of memory") ||
    m.includes("oom") ||
    m.includes("out-of-memory") ||
    // WebGPU buffer/binding-size limits present as memory failures.
    m.includes("exceeds the max") ||
    m.includes("maxstoragebufferbindingsize") ||
    m.includes("maxbuffersize") ||
    m.includes("failed to allocate") ||
    (m.includes("buffer") && m.includes("size") && m.includes("limit"))
  );
}

function isProbablyCacheError(err: unknown): boolean {
  const m = errText(err).toLowerCase();
  return (
    m.includes("cache") ||
    m.includes("indexeddb") ||
    m.includes("not found") ||
    m.includes("404") ||
    m.includes("missing") ||
    m.includes("failed to fetch") ||
    m.includes("network") ||
    m.includes("corrupt") ||
    m.includes("unexpected end") ||
    m.includes("integrity")
  );
}

class AbortError extends Error {
  constructor() {
    super("WebLLM initialization aborted");
    this.name = "AbortError";
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AbortError();
}
