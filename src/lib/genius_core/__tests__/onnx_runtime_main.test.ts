/**
 * OnnxRuntimeMain — Phase 1 backend tests.
 *
 * The transformers.js / onnxruntime-node stack is fully mocked so the suite
 * runs in vanilla Node without downloading 2.4 GB of model weights or
 * spinning up a GPU. We assert state-machine transitions, settings gating,
 * session caching, streamer wiring, error capture, and domain-event
 * publishing.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

// ── Hoisted mock surface ─────────────────────────────────────────────────

const h = vi.hoisted(() => {
  type Settings = {
    geniusCore?: {
      enabled?: boolean;
      vramBudgetGb?: number;
      executionProvider?: string;
      baseModelId?: string;
    };
  };
  const settings: { current: Settings } = {
    current: {
      geniusCore: {
        enabled: true,
        vramBudgetGb: 8,
        executionProvider: "auto",
        baseModelId: "phi-3-mini-4k-instruct-int4-onnx",
      },
    },
  };
  const events: Array<{ type: string; payload: unknown }> = [];
  const tokenizer = {
    apply_chat_template: vi.fn(
      (_msgs: unknown, _opts: unknown) => ({
        input_ids: { data: [1n, 2n, 3n] },
      }),
    ),
    decode: vi.fn((_ids: unknown, _opts: unknown) => "hello world"),
  };
  const model = {
    generate: vi.fn(async (opts: Record<string, unknown>) => {
      const streamer = opts.streamer as
        | { callback_function?: (s: string) => void }
        | undefined;
      // Emit streamed chunks if a streamer is provided.
      if (streamer && typeof streamer.callback_function === "function") {
        streamer.callback_function("hello ");
        streamer.callback_function("world");
      }
      // Return tokensIn (3) + 2 generated tokens.
      return { sequences: { data: [1n, 2n, 3n, 9n, 10n] } };
    }),
  };
  const TextStreamerCtor = vi.fn(function TextStreamer(
    this: { callback_function?: (s: string) => void },
    _tok: unknown,
    opts: { callback_function?: (s: string) => void },
  ) {
    this.callback_function = opts.callback_function;
  });
  const env: Record<string, unknown> = {};
  const transformers = {
    env,
    AutoTokenizer: { from_pretrained: vi.fn(async () => tokenizer) },
    AutoModelForCausalLM: { from_pretrained: vi.fn(async () => model) },
    TextStreamer: TextStreamerCtor,
  };
  return { settings, events, tokenizer, model, TextStreamerCtor, transformers };
});

vi.mock("electron", () => ({
  app: { getPath: (_k: string) => "/tmp/joycreate-test" },
}));

vi.mock("electron-log", () => {
  const noop = () => {};
  const scope = () => ({ info: noop, warn: noop, error: noop, debug: noop });
  return { default: { scope, info: noop, warn: noop, error: noop, debug: noop }, scope };
});

vi.mock("@/main/settings", () => ({
  readSettings: () => h.settings.current,
}));

vi.mock("@/lib/events/domain_event_bus", () => ({
  getDomainEventBus: () => ({
    publish: vi.fn(async (type: string, payload: unknown) => {
      h.events.push({ type, payload });
    }),
  }),
}));

vi.mock("@huggingface/transformers", () => h.transformers);

// Real facade — we want to assert setBackend integration too.
import { GeniusCore } from "../index";
import {
  OnnxRuntimeMain,
  activateOnnxRuntimeMainBackend,
} from "../onnx_runtime_main";

function resetSettings() {
  h.settings.current = {
    geniusCore: {
      enabled: true,
      vramBudgetGb: 8,
      executionProvider: "auto",
      baseModelId: "phi-3-mini-4k-instruct-int4-onnx",
    },
  };
}

describe("OnnxRuntimeMain — Phase 1 backend", () => {
  beforeEach(() => {
    h.events.length = 0;
    h.tokenizer.apply_chat_template.mockClear();
    h.tokenizer.decode.mockClear();
    h.model.generate.mockClear();
    h.TextStreamerCtor.mockClear();
    h.transformers.AutoTokenizer.from_pretrained.mockClear();
    h.transformers.AutoModelForCausalLM.from_pretrained.mockClear();
    resetSettings();
  });

  describe("init()", () => {
    it("refuses to start when geniusCore.enabled is false", async () => {
      h.settings.current = { geniusCore: { enabled: false, baseModelId: "x" } };
      const b = new OnnxRuntimeMain();
      await expect(b.init()).rejects.toThrow(/disabled/);
      const s = b.status();
      expect(s.status).toBe("error");
      expect(s.lastError).toMatch(/disabled/);
    });

    it("transitions to ready and publishes initialized event", async () => {
      const b = new OnnxRuntimeMain();
      await b.init();
      expect(b.status().status).toBe("ready");
      expect(h.events.find((e) => e.type === "genius_core.initialized")).toBeDefined();
    });

    it("is idempotent — second call is a no-op", async () => {
      const b = new OnnxRuntimeMain();
      await b.init();
      h.events.length = 0;
      await b.init();
      // No new initialized event because state is already 'ready'.
      expect(h.events.find((e) => e.type === "genius_core.initialized")).toBeUndefined();
    });

    it("sets transformers.env cache + remote/local flags", async () => {
      const b = new OnnxRuntimeMain();
      await b.init();
      expect(h.transformers.env.cacheDir).toMatch(/genius-core/);
      expect(h.transformers.env.allowRemoteModels).toBe(true);
      expect(h.transformers.env.allowLocalModels).toBe(true);
    });

    it("maps executionProvider settings ('directml' → 'dml')", async () => {
      h.settings.current.geniusCore!.executionProvider = "directml";
      const b = new OnnxRuntimeMain();
      await b.init();
      expect(b.status().executionProvider).toBe("dml");
    });
  });

  describe("loadBase()", () => {
    it("throws when called before init", async () => {
      const b = new OnnxRuntimeMain();
      await expect(b.loadBase()).rejects.toThrow(/init\(\)/);
    });

    it("throws on unknown baseModelId (validation precedes state change)", async () => {
      const b = new OnnxRuntimeMain();
      await b.init();
      h.settings.current.geniusCore!.baseModelId = "nope";
      await expect(b.loadBase()).rejects.toThrow(/Unknown Genius Core base model/);
      // Validation happens before the try-block so state stays 'ready'.
      expect(b.status().baseLoaded).toBe(false);
    });

    it("captures loader exceptions into status.lastError", async () => {
      h.transformers.AutoModelForCausalLM.from_pretrained.mockRejectedValueOnce(
        new Error("download failed"),
      );
      const b = new OnnxRuntimeMain();
      await b.init();
      await expect(b.loadBase()).rejects.toThrow(/download failed/);
      const s = b.status();
      expect(s.status).toBe("error");
      expect(s.lastError).toMatch(/download failed/);
    });

    it("loads tokenizer + model and publishes base.loaded event", async () => {
      const b = new OnnxRuntimeMain();
      await b.init();
      await b.loadBase();
      expect(h.transformers.AutoTokenizer.from_pretrained).toHaveBeenCalledTimes(1);
      expect(h.transformers.AutoModelForCausalLM.from_pretrained).toHaveBeenCalledTimes(1);
      const evt = h.events.find((e) => e.type === "genius_core.base.loaded");
      expect(evt).toBeDefined();
      expect((evt!.payload as { baseModelId: string }).baseModelId).toBe(
        "phi-3-mini-4k-instruct-int4-onnx",
      );
      expect(b.status().baseLoaded).toBe(true);
    });

    it("caches the session — second call does not re-download", async () => {
      const b = new OnnxRuntimeMain();
      await b.init();
      await b.loadBase();
      await b.loadBase();
      expect(h.transformers.AutoTokenizer.from_pretrained).toHaveBeenCalledTimes(1);
      expect(h.transformers.AutoModelForCausalLM.from_pretrained).toHaveBeenCalledTimes(1);
    });
  });

  describe("loadContextSlot()", () => {
    it("tracks the slot and publishes context_slot.loaded", async () => {
      const b = new OnnxRuntimeMain();
      await b.init();
      await b.loadContextSlot("proj-1");
      expect(b.status().loadedContextSlots).toContain("proj-1");
      const evt = h.events.find((e) => e.type === "genius_core.context_slot.loaded");
      expect(evt).toBeDefined();
      expect((evt!.payload as { projectId: string }).projectId).toBe("proj-1");
    });

    it("rejects when called before init", async () => {
      const b = new OnnxRuntimeMain();
      await expect(b.loadContextSlot("p")).rejects.toThrow(/init\(\)/);
    });
  });

  describe("infer()", () => {
    it("auto-loads the base model on first call", async () => {
      const b = new OnnxRuntimeMain();
      await b.init();
      const res = await b.infer({ prompt: "hi" });
      expect(res.text).toBe("hello world");
      expect(res.tokensIn).toBe(3);
      expect(res.tokensOut).toBe(2);
      expect(res.executionProvider).toBeTruthy();
      expect(typeof res.durationMs).toBe("number");
    });

    it("publishes inference.completed with correct counts", async () => {
      const b = new OnnxRuntimeMain();
      await b.init();
      await b.infer({ prompt: "hi", projectId: "p2" });
      const evt = h.events.find((e) => e.type === "genius_core.inference.completed");
      expect(evt).toBeDefined();
      const p = evt!.payload as { tokensIn: number; tokensOut: number; projectId: string };
      expect(p.tokensIn).toBe(3);
      expect(p.tokensOut).toBe(2);
      expect(p.projectId).toBe("p2");
    });

    it("records lastInference on status() after a successful infer()", async () => {
      const b = new OnnxRuntimeMain();
      await b.init();
      expect(b.status().lastInference).toBeFalsy();
      await b.infer({ prompt: "hi" });
      const li = b.status().lastInference;
      expect(li).toBeDefined();
      expect(li!.usedShardStream).toBe(false);
      expect(li!.tokensOut).toBe(2);
      expect(typeof li!.durationMs).toBe("number");
      expect(typeof li!.atMs).toBe("number");
    });

    it("passes temperature and maxTokens through to generate()", async () => {
      const b = new OnnxRuntimeMain();
      await b.init();
      await b.infer({ prompt: "hi", maxTokens: 16, temperature: 0.7 });
      const call = h.model.generate.mock.calls[0][0];
      expect(call.max_new_tokens).toBe(16);
      expect(call.temperature).toBe(0.7);
      expect(call.do_sample).toBe(true);
    });

    it("disables sampling when temperature is 0", async () => {
      const b = new OnnxRuntimeMain();
      await b.init();
      await b.infer({ prompt: "hi", temperature: 0 });
      const call = h.model.generate.mock.calls[0][0];
      expect(call.do_sample).toBe(false);
    });

    it("captures generation errors into status.lastError", async () => {
      h.model.generate.mockRejectedValueOnce(new Error("kaboom"));
      const b = new OnnxRuntimeMain();
      await b.init();
      await expect(b.infer({ prompt: "hi" })).rejects.toThrow(/kaboom/);
      const s = b.status();
      expect(s.status).toBe("error");
      expect(s.lastError).toMatch(/kaboom/);
    });
  });

  describe("streamInfer()", () => {
    it("forwards chunks via TextStreamer callback", async () => {
      const b = new OnnxRuntimeMain();
      await b.init();
      const chunks: string[] = [];
      const res = await b.streamInfer({ prompt: "hi" }, (c) => chunks.push(c));
      expect(chunks).toEqual(["hello ", "world"]);
      expect(res.tokensOut).toBe(2);
      expect(h.TextStreamerCtor).toHaveBeenCalledTimes(1);
    });

    it("isolates throwing chunk handlers", async () => {
      const b = new OnnxRuntimeMain();
      await b.init();
      await expect(
        b.streamInfer({ prompt: "hi" }, () => {
          throw new Error("subscriber blew up");
        }),
      ).resolves.toBeDefined();
    });
  });

  describe("shutdown()", () => {
    it("clears the session and resets state", async () => {
      const b = new OnnxRuntimeMain();
      await b.init();
      await b.loadBase();
      await b.loadContextSlot("p1");
      await b.shutdown();
      const s = b.status();
      expect(s.status).toBe("uninitialized");
      expect(s.baseLoaded).toBe(false);
      expect(s.loadedContextSlots).toEqual([]);
    });
  });

  describe("status()", () => {
    it("reflects settings even before init", () => {
      const b = new OnnxRuntimeMain();
      const s = b.status();
      expect(s.enabled).toBe(true);
      expect(s.baseModelId).toBe("phi-3-mini-4k-instruct-int4-onnx");
      expect(s.baseLoaded).toBe(false);
      expect(s.status).toBe("uninitialized");
    });
  });

  describe("activateOnnxRuntimeMainBackend()", () => {
    it("installs an OnnxRuntimeMain as the facade backend", async () => {
      await activateOnnxRuntimeMainBackend();
      // The facade now proxies to a real OnnxRuntimeMain instance; calling
      // status() should not throw and should reflect the settings.
      const s = GeniusCore.status();
      expect(s.enabled).toBe(true);
      expect(s.baseModelId).toBe("phi-3-mini-4k-instruct-int4-onnx");
    });
  });
});
