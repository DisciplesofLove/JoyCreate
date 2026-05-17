/**
 * Genius Core facade — Phase 0 contract tests.
 *
 * These exercise the singleton's state machine without booting any concrete
 * backend: every real subsystem (ONNX, layer swapping, encryption, etc.)
 * arrives in later phases. The tests guarantee:
 *
 *   • Calling any method on a fresh process throws "not initialized".
 *   • `setBackend` shuts down the previous backend before swapping.
 *   • Input validation rejects empty prompts / project ids.
 *   • `status()` returns a benign default for the uninitialized state.
 *
 * `electron-log` is mocked because the facade pulls it eagerly and the
 * test runner is a plain Node environment.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("electron-log", () => {
  const noop = () => {};
  const scope = () => ({ info: noop, warn: noop, error: noop, debug: noop });
  return {
    default: { scope, info: noop, warn: noop, error: noop, debug: noop },
    scope,
  };
});

import {
  GeniusCore,
  type GeniusCoreBackend,
  type GeniusCoreInferRequest,
  type GeniusCoreInferResponse,
  type GeniusCoreStatusReport,
} from "../index";

// Save the original (uninitialized) backend so each test can reset.
// The facade is a process-wide singleton; we restore between tests.
function makeStubBackend(overrides: Partial<GeniusCoreBackend> = {}): GeniusCoreBackend {
  const status: GeniusCoreStatusReport = {
    status: "ready",
    enabled: true,
    executionProvider: "cpu",
    baseModelId: "stub",
    baseLoaded: true,
    loadedContextSlots: [],
    vramBudgetGb: 8,
    vramUsedBytes: 0,
  };
  return {
    init: vi.fn(async () => {}),
    loadBase: vi.fn(async () => {}),
    loadContextSlot: vi.fn(async () => {}),
    infer: vi.fn(
      async (_req: GeniusCoreInferRequest): Promise<GeniusCoreInferResponse> => ({
        text: "ok",
        tokensIn: 1,
        tokensOut: 1,
        durationMs: 1,
        executionProvider: "cpu",
        usedShardStream: false,
      }),
    ),
    streamInfer: vi.fn(
      async (
        _req: GeniusCoreInferRequest,
        onChunk: (c: string) => void,
      ): Promise<GeniusCoreInferResponse> => {
        onChunk("ok");
        return {
          text: "ok",
          tokensIn: 1,
          tokensOut: 1,
          durationMs: 1,
          executionProvider: "cpu",
          usedShardStream: false,
        };
      },
    ),
    status: vi.fn(() => status),
    shutdown: vi.fn(async () => {}),
    ...overrides,
  };
}

describe("GeniusCore facade — Phase 0 contract", () => {
  beforeEach(async () => {
    // Reset to a fresh UninitializedBackend equivalent: install a stub that
    // throws like the real one, so each test starts deterministically.
    const uninit: GeniusCoreBackend = {
      init: vi.fn(async () => {
        throw new Error("Genius Core backend is not wired yet");
      }),
      loadBase: vi.fn(async () => {
        throw new Error("Genius Core not initialized");
      }),
      loadContextSlot: vi.fn(async () => {
        throw new Error("Genius Core not initialized");
      }),
      infer: vi.fn(async () => {
        throw new Error("Genius Core not initialized");
      }),
      streamInfer: vi.fn(async () => {
        throw new Error("Genius Core not initialized");
      }),
      status: vi.fn(() => ({
        status: "uninitialized",
        enabled: false,
        executionProvider: null,
        baseModelId: null,
        baseLoaded: false,
        loadedContextSlots: [],
        vramBudgetGb: 0,
        vramUsedBytes: 0,
      })),
      shutdown: vi.fn(async () => {}),
    };
    await GeniusCore.setBackend(uninit);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("status() reports `uninitialized` with safe defaults before init", () => {
    const s = GeniusCore.status();
    expect(s.status).toBe("uninitialized");
    expect(s.enabled).toBe(false);
    expect(s.baseLoaded).toBe(false);
    expect(s.executionProvider).toBeNull();
    expect(s.baseModelId).toBeNull();
    expect(s.loadedContextSlots).toEqual([]);
  });

  it("init() rejects loudly on the uninitialized backend", async () => {
    await expect(GeniusCore.init()).rejects.toThrow(/not wired|not initialized/);
  });

  it("loadContextSlot() rejects when no projectId is supplied", async () => {
    await expect(GeniusCore.loadContextSlot("")).rejects.toThrow(/projectId is required/);
  });

  it("infer() rejects when prompt is empty", async () => {
    await expect(
      GeniusCore.infer({ prompt: "" } as GeniusCoreInferRequest),
    ).rejects.toThrow(/prompt is required/);
  });

  it("streamInfer() rejects when prompt is empty", async () => {
    await expect(
      GeniusCore.streamInfer(
        { prompt: "" } as GeniusCoreInferRequest,
        () => {},
      ),
    ).rejects.toThrow(/prompt is required/);
  });

  it("setBackend() shuts down the previous backend before swapping", async () => {
    const first = makeStubBackend();
    await GeniusCore.setBackend(first);
    const second = makeStubBackend();
    await GeniusCore.setBackend(second);
    expect(first.shutdown).toHaveBeenCalledTimes(1);
    // The new backend is now active.
    const res = await GeniusCore.infer({ prompt: "hi" });
    expect(res.text).toBe("ok");
    expect(second.infer).toHaveBeenCalledTimes(1);
    expect(first.infer).not.toHaveBeenCalled();
  });

  it("setBackend() tolerates a throwing previous shutdown", async () => {
    const bad = makeStubBackend({
      shutdown: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    await GeniusCore.setBackend(bad);
    const good = makeStubBackend();
    // The swap must not propagate the shutdown error.
    await expect(GeniusCore.setBackend(good)).resolves.toBeUndefined();
    const s = GeniusCore.status();
    expect(s.status).toBe("ready");
  });

  it("delegates infer/loadContextSlot/streamInfer to the active backend", async () => {
    const b = makeStubBackend();
    await GeniusCore.setBackend(b);
    await GeniusCore.loadContextSlot("p1");
    await GeniusCore.infer({ prompt: "hi", projectId: "p1" });
    const chunks: string[] = [];
    const result = await GeniusCore.streamInfer({ prompt: "hi" }, (c) => chunks.push(c));
    expect(b.loadContextSlot).toHaveBeenCalledWith("p1");
    expect(b.infer).toHaveBeenCalledWith(expect.objectContaining({ prompt: "hi" }));
    expect(chunks).toEqual(["ok"]);
    expect(result.tokensOut).toBe(1);
  });
});
