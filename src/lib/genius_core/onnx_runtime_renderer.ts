/**
 * Genius Core ONNX Renderer — host-side client.
 *
 * Owns a single web Worker that runs {@link onnx_runtime_renderer.worker}.
 * Exposes a typed promise/streaming API mirroring the main-process backend
 * so components / hooks have a uniform contract regardless of where
 * inference physically runs.
 *
 * This module lives in the *renderer*. It must never be imported from the
 * main process — there is no IPC roundtrip.
 *
 * The Worker is constructed lazily on first use via `new Worker(new URL(
 * "./onnx_runtime_renderer.worker.ts", import.meta.url), { type: "module" })`
 * so Vite/webpack-style bundlers can resolve the module graph at build time
 * (no CDN imports, fully offline-capable). For unit tests a custom worker
 * factory may be injected.
 */

import type {
  GeniusCoreInferRequest,
  GeniusCoreInferResponse,
} from "@/lib/genius_core";

// ── Public types ─────────────────────────────────────────────────────────

export interface OnnxRuntimeRendererOptions {
  /** Hugging Face repo to load as the base model. */
  hfRepo: string;
  /** Optional dtype hint forwarded to transformers.js (e.g. "q4", "fp16"). */
  dtype?: string;
  /**
   * Optional worker factory for testing. When omitted the client constructs
   * a real Worker pointing at the bundled worker module.
   */
  workerFactory?: () => Worker;
}

interface PendingRequest {
  resolve: (value: GeniusCoreInferResponse | void) => void;
  reject: (err: Error) => void;
  onChunk?: (chunk: string) => void;
}

// Same wire protocol shapes as the worker.
interface InferResult {
  text: string;
  tokensIn: number;
  tokensOut: number;
  durationMs: number;
  executionProvider: string;
}

type OutboundMessage =
  | { type: "init:ok"; id: number }
  | { type: "load-base:ok"; id: number; payload: { loadDurationMs: number } }
  | { type: "infer:chunk"; id: number; payload: { chunk: string } }
  | { type: "infer:ok"; id: number; payload: InferResult }
  | { type: "shutdown:ok"; id: number }
  | { type: "error"; id: number; error: string };

// ── Default worker factory (renderer-only) ───────────────────────────────

function defaultWorkerFactory(): Worker {
  // The `new URL(..., import.meta.url)` form is what Vite needs to fingerprint
  // the worker source and emit a separate bundle. This call deliberately
  // happens inside a function so importing this module from a non-bundler
  // context (jest, tsc-only) does not crash.
  return new Worker(
    new URL("./onnx_runtime_renderer.worker.ts", import.meta.url),
    { type: "module" },
  );
}

// ── Client ───────────────────────────────────────────────────────────────

export class OnnxRuntimeRenderer {
  private readonly opts: OnnxRuntimeRendererOptions;
  private worker: Worker | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private initPromise: Promise<void> | null = null;
  private basePromise: Promise<void> | null = null;
  private disposed = false;

  constructor(opts: OnnxRuntimeRendererOptions) {
    this.opts = opts;
  }

  // ── Worker lifecycle ───────────────────────────────────────────────────

  private getWorker(): Worker {
    if (this.disposed) {
      throw new Error("OnnxRuntimeRenderer has been shut down");
    }
    if (!this.worker) {
      const factory = this.opts.workerFactory ?? defaultWorkerFactory;
      this.worker = factory();
      this.worker.addEventListener(
        "message",
        (e: MessageEvent<OutboundMessage>) => this.onMessage(e.data),
      );
      this.worker.addEventListener("error", (e: ErrorEvent) => {
        // Reject every in-flight request so callers don't hang.
        const err = new Error(`Genius Core renderer worker crashed: ${e.message}`);
        for (const [, p] of this.pending) p.reject(err);
        this.pending.clear();
        this.worker = null;
        this.initPromise = null;
        this.basePromise = null;
      });
    }
    return this.worker;
  }

  private onMessage(msg: OutboundMessage) {
    const p = this.pending.get(msg.id);
    if (!p) return;
    switch (msg.type) {
      case "init:ok":
      case "load-base:ok":
      case "shutdown:ok":
        this.pending.delete(msg.id);
        p.resolve();
        return;
      case "infer:chunk":
        if (p.onChunk) {
          try {
            p.onChunk(msg.payload.chunk);
          } catch (err) {
            // Isolate subscriber errors so they don't cancel the request.
            // Mirror facade behaviour: log and continue.
            console.warn("Genius Core stream chunk handler threw", err);
          }
        }
        return;
      case "infer:ok":
        this.pending.delete(msg.id);
        p.resolve({
          text: msg.payload.text,
          tokensIn: msg.payload.tokensIn,
          tokensOut: msg.payload.tokensOut,
          durationMs: msg.payload.durationMs,
          executionProvider: msg.payload.executionProvider,
          usedShardStream: false,
        });
        return;
      case "error":
        this.pending.delete(msg.id);
        p.reject(new Error(msg.error));
        return;
    }
  }

  private send<T>(
    msg: { type: string; payload?: unknown },
    onChunk?: (chunk: string) => void,
  ): Promise<T> {
    const id = this.nextId++;
    const w = this.getWorker();
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as PendingRequest["resolve"],
        reject,
        onChunk,
      });
      try {
        w.postMessage({ ...msg, id });
      } catch (err) {
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  // ── Public API ─────────────────────────────────────────────────────────

  /** Idempotent: only sends 'init' to the worker once per instance. */
  async init(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.send<void>({ type: "init" });
    }
    return this.initPromise;
  }

  /** Idempotent: only sends 'load-base' once per (hfRepo, dtype) tuple. */
  async loadBase(): Promise<void> {
    if (!this.basePromise) {
      this.basePromise = (async () => {
        await this.init();
        await this.send<void>({
          type: "load-base",
          payload: { hfRepo: this.opts.hfRepo, dtype: this.opts.dtype ?? "q4" },
        });
      })();
    }
    return this.basePromise;
  }

  async infer(req: GeniusCoreInferRequest): Promise<GeniusCoreInferResponse> {
    if (!req?.prompt) throw new Error("prompt is required");
    await this.loadBase();
    return this.send<GeniusCoreInferResponse>({
      type: "infer",
      payload: {
        prompt: req.prompt,
        maxTokens: req.maxTokens,
        temperature: req.temperature,
        stream: false,
      },
    });
  }

  async streamInfer(
    req: GeniusCoreInferRequest,
    onChunk: (chunk: string) => void,
  ): Promise<GeniusCoreInferResponse> {
    if (!req?.prompt) throw new Error("prompt is required");
    await this.loadBase();
    return this.send<GeniusCoreInferResponse>(
      {
        type: "infer",
        payload: {
          prompt: req.prompt,
          maxTokens: req.maxTokens,
          temperature: req.temperature,
          stream: true,
        },
      },
      onChunk,
    );
  }

  async shutdown(): Promise<void> {
    if (this.disposed) return;
    if (this.worker) {
      try {
        await this.send<void>({ type: "shutdown" });
      } catch {
        /* worker may already be gone */
      }
      try {
        this.worker.terminate();
      } catch {
        /* ignore */
      }
    }
    this.worker = null;
    this.initPromise = null;
    this.basePromise = null;
    this.disposed = true;
    for (const [, p] of this.pending) {
      p.reject(new Error("OnnxRuntimeRenderer shut down"));
    }
    this.pending.clear();
  }
}
