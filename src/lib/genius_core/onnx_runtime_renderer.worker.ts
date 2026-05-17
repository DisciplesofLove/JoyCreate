/**
 * Genius Core ONNX Renderer Worker.
 *
 * Runs in a dedicated Web Worker (renderer-side) and hosts transformers.js
 * with the `onnxruntime-web` backend. Owners spawn this worker via
 * {@link OnnxRuntimeRenderer} which lives in the renderer process — there
 * is **no IPC roundtrip to the main process** for inference here, which is
 * the entire point of Phase 2: keep heavy compute off the React thread
 * while still preserving the same {@link GeniusCoreBackend} surface area
 * that the main-process backend exposes (Phase 1).
 *
 * Wire protocol
 * -------------
 *   ↦ { type: "init", id, payload?: { modelId?, hfRepo? } }
 *   ↤ { type: "init:ok",  id }                | { type: "error", id, error }
 *
 *   ↦ { type: "load-base", id, payload: { hfRepo, dtype } }
 *   ↤ { type: "load-base:ok", id, payload: { loadDurationMs } }
 *
 *   ↦ { type: "infer", id, payload: { prompt, maxTokens?, temperature?, stream?: boolean } }
 *   ↤ { type: "infer:chunk", id, payload: { chunk } }    (zero-or-more)
 *   ↤ { type: "infer:ok", id, payload: GeniusCoreInferResponse }
 *
 *   ↦ { type: "shutdown", id }
 *   ↤ { type: "shutdown:ok", id }
 *
 * Errors are always returned as `{ type: "error", id, error: string }`.
 * The worker never throws asynchronously to its host — every code path is
 * wrapped so the renderer side can resolve/reject deterministically.
 */

/// <reference lib="webworker" />

import type {
  AutoModelForCausalLM as AutoModelForCausalLMType,
  AutoTokenizer as AutoTokenizerType,
  TextStreamer as TextStreamerType,
} from "@huggingface/transformers";

// ── Module-scope state ───────────────────────────────────────────────────

interface SessionRefs {
  model: InstanceType<typeof AutoModelForCausalLMType>;
  tokenizer: InstanceType<typeof AutoTokenizerType>;
  hfRepo: string;
  loadedAtMs: number;
}

let transformers: typeof import("@huggingface/transformers") | null = null;
let session: SessionRefs | null = null;
let initialized = false;

async function loadTransformers(): Promise<typeof import("@huggingface/transformers")> {
  if (!transformers) {
    transformers = await import("@huggingface/transformers");
    // Prefer WebGPU when available; fallback to wasm. Browser-side ORT
    // picks the right binary based on `env.backends.onnx.wasm.proxy`.
    const env = transformers.env;
    if (env?.backends?.onnx) {
      // Let ORT decide; renderer ships the WASM artifacts via Vite.
      env.backends.onnx.wasm = env.backends.onnx.wasm ?? {};
      env.backends.onnx.wasm.proxy = false;
    }
  }
  return transformers;
}

// ── Message types ────────────────────────────────────────────────────────

export interface GeniusCoreRendererInferPayload {
  prompt: string;
  maxTokens?: number;
  temperature?: number;
  stream?: boolean;
}

export interface GeniusCoreRendererInferResult {
  text: string;
  tokensIn: number;
  tokensOut: number;
  durationMs: number;
  executionProvider: "wasm" | "webgpu" | "auto";
}

type InboundMessage =
  | { type: "init"; id: number }
  | { type: "load-base"; id: number; payload: { hfRepo: string; dtype?: string } }
  | { type: "infer"; id: number; payload: GeniusCoreRendererInferPayload }
  | { type: "shutdown"; id: number };

type OutboundMessage =
  | { type: "init:ok"; id: number }
  | { type: "load-base:ok"; id: number; payload: { loadDurationMs: number } }
  | { type: "infer:chunk"; id: number; payload: { chunk: string } }
  | { type: "infer:ok"; id: number; payload: GeniusCoreRendererInferResult }
  | { type: "shutdown:ok"; id: number }
  | { type: "error"; id: number; error: string };

// `self` in a worker context is `DedicatedWorkerGlobalScope`.
declare const self: DedicatedWorkerGlobalScope & {
  postMessage(message: OutboundMessage): void;
};

function reply(msg: OutboundMessage) {
  self.postMessage(msg);
}

function fail(id: number, err: unknown) {
  reply({
    type: "error",
    id,
    error: err instanceof Error ? err.message : String(err),
  });
}

// ── Message handlers ─────────────────────────────────────────────────────

async function handleInit(id: number) {
  await loadTransformers();
  initialized = true;
  reply({ type: "init:ok", id });
}

async function handleLoadBase(
  id: number,
  payload: { hfRepo: string; dtype?: string },
) {
  if (!initialized) {
    throw new Error("Worker not initialized — send 'init' first");
  }
  if (session?.hfRepo === payload.hfRepo) {
    reply({ type: "load-base:ok", id, payload: { loadDurationMs: 0 } });
    return;
  }
  const t = await loadTransformers();
  const t0 = Date.now();
  const tokenizer = await t.AutoTokenizer.from_pretrained(payload.hfRepo);
  const model = await t.AutoModelForCausalLM.from_pretrained(payload.hfRepo, {
    dtype: (payload.dtype as never) ?? ("q4" as never),
  } as never);
  session = {
    model: model as InstanceType<typeof AutoModelForCausalLMType>,
    tokenizer: tokenizer as InstanceType<typeof AutoTokenizerType>,
    hfRepo: payload.hfRepo,
    loadedAtMs: Date.now(),
  };
  reply({
    type: "load-base:ok",
    id,
    payload: { loadDurationMs: Date.now() - t0 },
  });
}

async function handleInfer(id: number, payload: GeniusCoreRendererInferPayload) {
  if (!session) {
    throw new Error("Base model not loaded — send 'load-base' first");
  }
  const t = await loadTransformers();
  const tokenizer = session.tokenizer as unknown as {
    apply_chat_template: (
      msgs: Array<{ role: string; content: string }>,
      opts: { tokenize: boolean; add_generation_prompt: boolean },
    ) => { input_ids: { data?: ArrayLike<bigint | number> } };
    decode: (ids: number[], opts?: { skip_special_tokens?: boolean }) => string;
  };
  const model = session.model as unknown as {
    generate: (opts: Record<string, unknown>) => Promise<unknown>;
  };

  const t0 = Date.now();
  const inputs = tokenizer.apply_chat_template(
    [{ role: "user", content: payload.prompt }],
    { tokenize: true, add_generation_prompt: true },
  );
  const tokensIn = inputs.input_ids?.data?.length ?? 0;

  const streamer = payload.stream
    ? new (t.TextStreamer as typeof TextStreamerType)(
        session.tokenizer as never,
        {
          skip_prompt: true,
          skip_special_tokens: true,
          callback_function: (chunk: string) => {
            reply({ type: "infer:chunk", id, payload: { chunk } });
          },
        } as never,
      )
    : undefined;

  const out = (await model.generate({
    ...(inputs as object),
    max_new_tokens: payload.maxTokens ?? 256,
    do_sample: typeof payload.temperature === "number" && payload.temperature > 0,
    temperature: payload.temperature ?? 0.0,
    streamer,
  })) as
    | { sequences?: { data?: ArrayLike<bigint | number> } }
    | ArrayLike<ArrayLike<bigint | number>>;

  const firstSeq: ArrayLike<bigint | number> | undefined = Array.isArray(out)
    ? (out as ArrayLike<ArrayLike<bigint | number>>)[0]
    : (out as { sequences?: { data?: ArrayLike<bigint | number> } }).sequences?.data;

  const generated: number[] = [];
  if (firstSeq) {
    for (let i = 0; i < firstSeq.length; i++) {
      const v = firstSeq[i];
      generated.push(typeof v === "bigint" ? Number(v) : (v as number));
    }
  }
  const newTokens = generated.slice(tokensIn);
  const text = tokenizer.decode(newTokens, { skip_special_tokens: true });

  reply({
    type: "infer:ok",
    id,
    payload: {
      text,
      tokensIn,
      tokensOut: newTokens.length,
      durationMs: Date.now() - t0,
      executionProvider: "auto",
    },
  });
}

function handleShutdown(id: number) {
  session = null;
  initialized = false;
  reply({ type: "shutdown:ok", id });
}

// ── Router ───────────────────────────────────────────────────────────────

/**
 * Exported so the unit test can drive the protocol synchronously without
 * spawning a real Worker. In a real worker context, the message handler
 * below wires `self.onmessage` to this router.
 */
export async function dispatch(msg: InboundMessage): Promise<void> {
  try {
    switch (msg.type) {
      case "init":
        await handleInit(msg.id);
        return;
      case "load-base":
        await handleLoadBase(msg.id, msg.payload);
        return;
      case "infer":
        await handleInfer(msg.id, msg.payload);
        return;
      case "shutdown":
        handleShutdown(msg.id);
        return;
      default:
        fail((msg as { id: number }).id, `Unknown message type: ${(msg as { type: string }).type}`);
    }
  } catch (err) {
    fail(msg.id, err);
  }
}

// Only attach the listener when we're actually running inside a worker.
// During unit tests `self` is undefined, and we just import `dispatch`.
if (typeof self !== "undefined" && typeof (self as DedicatedWorkerGlobalScope).addEventListener === "function") {
  self.addEventListener("message", (event: MessageEvent<InboundMessage>) => {
    void dispatch(event.data);
  });
}
