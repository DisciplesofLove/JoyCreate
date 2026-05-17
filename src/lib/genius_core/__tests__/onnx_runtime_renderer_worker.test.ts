/**
 * Genius Core renderer worker — protocol tests.
 *
 * We import the worker module directly and exercise its `dispatch()` router
 * with mocked transformers.js + a stubbed `self.postMessage`. This verifies
 * the wire protocol shape, idempotency, validation, error envelopes, and
 * streaming chunk emission without spawning a real Web Worker.
 */

import { describe, expect, it, vi, beforeEach, afterAll } from "vitest";

// ── Hoisted state ────────────────────────────────────────────────────────

const h = vi.hoisted(() => {
  const tokenizer = {
    apply_chat_template: vi.fn(() => ({ input_ids: { data: [1n, 2n, 3n] } })),
    decode: vi.fn(() => "hello"),
  };
  const model = {
    generate: vi.fn(async (opts: Record<string, unknown>) => {
      const streamer = opts.streamer as
        | { callback_function?: (s: string) => void }
        | undefined;
      if (streamer?.callback_function) {
        streamer.callback_function("hel");
        streamer.callback_function("lo");
      }
      return { sequences: { data: [1n, 2n, 3n, 9n] } };
    }),
  };
  const TextStreamerCtor = vi.fn(function TextStreamer(
    this: { callback_function?: (s: string) => void },
    _tok: unknown,
    opts: { callback_function?: (s: string) => void },
  ) {
    this.callback_function = opts.callback_function;
  });
  const transformers = {
    env: { backends: { onnx: { wasm: {} } } },
    AutoTokenizer: { from_pretrained: vi.fn(async () => tokenizer) },
    AutoModelForCausalLM: { from_pretrained: vi.fn(async () => model) },
    TextStreamer: TextStreamerCtor,
  };
  return { tokenizer, model, TextStreamerCtor, transformers };
});

vi.mock("@huggingface/transformers", () => h.transformers);

import { dispatch } from "../onnx_runtime_renderer.worker";

// Capture worker output via a spy on `self.postMessage`. In happy-dom,
// `self === window` and direct property assignment is shadowed by an
// internal getter; `vi.spyOn` patches reliably.
const posted: unknown[] = [];
const postMessageSpy = vi
  .spyOn(self, "postMessage")
  .mockImplementation((m: unknown) => {
    posted.push(m);
  });

function reset() {
  posted.length = 0;
  h.tokenizer.apply_chat_template.mockClear();
  h.tokenizer.decode.mockClear();
  h.model.generate.mockClear();
  h.TextStreamerCtor.mockClear();
  h.transformers.AutoTokenizer.from_pretrained.mockClear();
  h.transformers.AutoModelForCausalLM.from_pretrained.mockClear();
}

describe("renderer worker dispatch()", () => {
  beforeEach(reset);

  it("init → init:ok", async () => {
    await dispatch({ type: "init", id: 1 });
    expect(posted).toEqual([{ type: "init:ok", id: 1 }]);
  });

  it("load-base before init returns an error envelope", async () => {
    // Manually reset module state via a fresh shutdown then test.
    await dispatch({ type: "shutdown", id: 99 });
    reset();
    await dispatch({
      type: "load-base",
      id: 2,
      payload: { hfRepo: "x/y", dtype: "q4" },
    });
    expect(posted).toHaveLength(1);
    expect((posted[0] as { type: string }).type).toBe("error");
    expect((posted[0] as { error: string }).error).toMatch(/not initialized/);
  });

  it("init → load-base → load-base:ok with loader call", async () => {
    await dispatch({ type: "init", id: 1 });
    reset();
    await dispatch({
      type: "load-base",
      id: 2,
      payload: { hfRepo: "microsoft/Phi-3-mini-4k-instruct-onnx-web", dtype: "q4" },
    });
    expect(posted).toHaveLength(1);
    expect((posted[0] as { type: string }).type).toBe("load-base:ok");
    expect(h.transformers.AutoTokenizer.from_pretrained).toHaveBeenCalledWith(
      "microsoft/Phi-3-mini-4k-instruct-onnx-web",
    );
    expect(h.transformers.AutoModelForCausalLM.from_pretrained).toHaveBeenCalled();
  });

  it("load-base is idempotent for the same hfRepo", async () => {
    await dispatch({ type: "init", id: 1 });
    await dispatch({
      type: "load-base",
      id: 2,
      payload: { hfRepo: "repo/a", dtype: "q4" },
    });
    h.transformers.AutoTokenizer.from_pretrained.mockClear();
    h.transformers.AutoModelForCausalLM.from_pretrained.mockClear();
    await dispatch({
      type: "load-base",
      id: 3,
      payload: { hfRepo: "repo/a", dtype: "q4" },
    });
    expect(h.transformers.AutoTokenizer.from_pretrained).not.toHaveBeenCalled();
    expect(h.transformers.AutoModelForCausalLM.from_pretrained).not.toHaveBeenCalled();
  });

  it("infer without prior load-base returns error", async () => {
    await dispatch({ type: "shutdown", id: 99 });
    reset();
    await dispatch({ type: "init", id: 1 });
    reset();
    await dispatch({
      type: "infer",
      id: 5,
      payload: { prompt: "hi" },
    });
    expect((posted[0] as { type: string }).type).toBe("error");
    expect((posted[0] as { error: string }).error).toMatch(/not loaded/);
  });

  it("infer (non-streaming) returns infer:ok with token counts", async () => {
    await dispatch({ type: "init", id: 1 });
    await dispatch({
      type: "load-base",
      id: 2,
      payload: { hfRepo: "repo/b", dtype: "q4" },
    });
    reset();
    await dispatch({
      type: "infer",
      id: 5,
      payload: { prompt: "hi", maxTokens: 32, temperature: 0.5 },
    });
    const ok = posted.find(
      (m) => (m as { type: string }).type === "infer:ok",
    ) as { payload: { text: string; tokensIn: number; tokensOut: number } };
    expect(ok).toBeDefined();
    expect(ok.payload.text).toBe("hello");
    expect(ok.payload.tokensIn).toBe(3);
    expect(ok.payload.tokensOut).toBe(1);
    const call = h.model.generate.mock.calls[0][0];
    expect(call.max_new_tokens).toBe(32);
    expect(call.do_sample).toBe(true);
    expect(call.temperature).toBe(0.5);
  });

  it("infer (streaming) emits infer:chunk envelopes then infer:ok", async () => {
    await dispatch({ type: "init", id: 1 });
    await dispatch({
      type: "load-base",
      id: 2,
      payload: { hfRepo: "repo/c", dtype: "q4" },
    });
    reset();
    await dispatch({
      type: "infer",
      id: 7,
      payload: { prompt: "hi", stream: true },
    });
    const chunks = posted.filter(
      (m) => (m as { type: string }).type === "infer:chunk",
    );
    expect(chunks).toHaveLength(2);
    expect((chunks[0] as { payload: { chunk: string } }).payload.chunk).toBe("hel");
    expect((chunks[1] as { payload: { chunk: string } }).payload.chunk).toBe("lo");
    const ok = posted.find((m) => (m as { type: string }).type === "infer:ok");
    expect(ok).toBeDefined();
    expect(h.TextStreamerCtor).toHaveBeenCalledTimes(1);
  });

  it("generate() rejection is reported as error envelope", async () => {
    await dispatch({ type: "init", id: 1 });
    await dispatch({
      type: "load-base",
      id: 2,
      payload: { hfRepo: "repo/d", dtype: "q4" },
    });
    h.model.generate.mockRejectedValueOnce(new Error("oom"));
    reset();
    await dispatch({
      type: "infer",
      id: 8,
      payload: { prompt: "hi" },
    });
    expect(posted).toHaveLength(1);
    expect((posted[0] as { type: string }).type).toBe("error");
    expect((posted[0] as { error: string }).error).toMatch(/oom/);
  });

  it("shutdown clears state and replies shutdown:ok", async () => {
    await dispatch({ type: "init", id: 1 });
    await dispatch({
      type: "load-base",
      id: 2,
      payload: { hfRepo: "repo/e", dtype: "q4" },
    });
    reset();
    await dispatch({ type: "shutdown", id: 9 });
    expect(posted).toEqual([{ type: "shutdown:ok", id: 9 }]);
    // After shutdown, infer is rejected again with "not loaded".
    reset();
    await dispatch({
      type: "infer",
      id: 10,
      payload: { prompt: "x" },
    });
    expect((posted[0] as { type: string }).type).toBe("error");
  });

  it("unknown message type returns error", async () => {
    reset();
    await dispatch({ type: "garbage" as never, id: 11 } as never);
    expect((posted[0] as { type: string }).type).toBe("error");
    expect((posted[0] as { error: string }).error).toMatch(/Unknown/);
  });
});

// Restore globals so other suites are unaffected.
afterAll(() => {
  postMessageSpy.mockRestore();
});
