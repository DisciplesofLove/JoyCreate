/**
 * Genius Core IPC handlers — input validation + persistence tests.
 *
 * We mock Electron (no `ipcMain` in node), `electron-log` (eager import in
 * the facade), `@/main/settings` (no file system), and the `GeniusCore`
 * facade (no real backend boot). Each `ipcMain.handle` call is captured so
 * tests can invoke the channel function directly with a fake event.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

// ── Mocks ─────────────────────────────────────────────────────────────────

type HandlerFn = (event: unknown, ...args: unknown[]) => unknown;

const hoisted = vi.hoisted(() => {
  const registered = new Map<string, HandlerFn>();
  const writeSettingsMock = vi.fn();
  const readSettingsMock = vi.fn(() => ({
    geniusCore: {
      enabled: false,
      vramBudgetGb: 8,
      baseModelId: "phi-3-mini-4k-instruct-int4-onnx",
      executionProvider: "auto",
      npuOffloadEnabled: false,
      weightStreamingEnabled: false,
      keystrokeLoggerEnabled: false,
      nightlyDistillationEnabled: false,
    },
  }));
  const geniusCoreMock = {
    init: vi.fn(async () => {}),
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
    loadContextSlot: vi.fn(async () => {}),
    infer: vi.fn(async () => ({
      text: "ok",
      tokensIn: 1,
      tokensOut: 1,
      durationMs: 1,
      executionProvider: "cpu",
      usedShardStream: false,
    })),
    streamInfer: vi.fn(async (_req: unknown, onChunk: (c: string) => void) => {
      onChunk("ok");
      return {
        text: "ok",
        tokensIn: 1,
        tokensOut: 1,
        durationMs: 1,
        executionProvider: "cpu",
        usedShardStream: false,
      };
    }),
    shutdown: vi.fn(async () => {}),
  };
  return { registered, writeSettingsMock, readSettingsMock, geniusCoreMock };
});

const { registered, writeSettingsMock, readSettingsMock, geniusCoreMock } = hoisted;

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, fn: HandlerFn) => {
      hoisted.registered.set(channel, fn);
    },
  },
}));

vi.mock("electron-log", () => {
  const noop = () => {};
  const scope = () => ({ info: noop, warn: noop, error: noop, debug: noop });
  return {
    default: { scope, info: noop, warn: noop, error: noop, debug: noop },
    scope,
  };
});

vi.mock("@/main/settings", () => ({
  readSettings: () => hoisted.readSettingsMock(),
  writeSettings: (s: unknown) => hoisted.writeSettingsMock(s),
}));

vi.mock("@/lib/genius_core", () => ({
  GeniusCore: hoisted.geniusCoreMock,
}));

// Imports must come after mocks.
import {
  assertInferRequest,
  listBaseModels,
  registerGeniusCoreHandlers,
} from "../genius_core_handlers";

function call(channel: string, ...args: unknown[]) {
  const fn = registered.get(channel);
  if (!fn) throw new Error(`Handler not registered: ${channel}`);
  return fn({ sender: { isDestroyed: () => false, send: vi.fn() } }, ...args);
}

describe("assertInferRequest", () => {
  it("rejects non-object input", () => {
    expect(() => assertInferRequest(null)).toThrow();
    expect(() => assertInferRequest("hi")).toThrow();
    expect(() => assertInferRequest(123)).toThrow();
  });

  it("rejects missing or empty prompt", () => {
    expect(() => assertInferRequest({})).toThrow(/prompt/);
    expect(() => assertInferRequest({ prompt: "" })).toThrow(/prompt/);
    expect(() => assertInferRequest({ prompt: 123 })).toThrow(/prompt/);
  });

  it("rejects non-positive maxTokens / negative temperature", () => {
    expect(() => assertInferRequest({ prompt: "x", maxTokens: 0 })).toThrow(/maxTokens/);
    expect(() => assertInferRequest({ prompt: "x", maxTokens: -1 })).toThrow(/maxTokens/);
    expect(() => assertInferRequest({ prompt: "x", temperature: -0.1 })).toThrow(/temperature/);
  });

  it("returns a clean request object on the happy path", () => {
    const r = assertInferRequest({
      prompt: "hi",
      projectId: "p1",
      maxTokens: 64,
      temperature: 0.7,
      extra: "stripped",
    });
    expect(r).toEqual({ prompt: "hi", projectId: "p1", maxTokens: 64, temperature: 0.7 });
  });

  it("preserves undefined for absent optional fields", () => {
    const r = assertInferRequest({ prompt: "hi" });
    expect(r.projectId).toBeUndefined();
    expect(r.maxTokens).toBeUndefined();
    expect(r.temperature).toBeUndefined();
  });
});

describe("listBaseModels", () => {
  it("maps every catalogue entry to the IPC shape", () => {
    const out = listBaseModels();
    expect(out.length).toBeGreaterThan(0);
    for (const e of out) {
      expect(e.id).toBeTruthy();
      expect(e.displayName).toBeTruthy();
      expect(e.format).toBe("onnx");
      expect(e.quantization).toBeTruthy();
      expect(e.contextWindow).toBeGreaterThan(0);
      expect(Array.isArray(e.executionProviders)).toBe(true);
      expect(e.executionProviders.length).toBeGreaterThan(0);
      expect(e.approxBytes).toBeGreaterThan(0);
    }
  });
});

describe("registerGeniusCoreHandlers", () => {
  beforeEach(() => {
    registered.clear();
    writeSettingsMock.mockClear();
    readSettingsMock.mockClear();
    Object.values(geniusCoreMock).forEach((m) => (m as ReturnType<typeof vi.fn>).mockClear?.());
    registerGeniusCoreHandlers();
  });

  it("registers all fifteen channels", () => {
    expect([...registered.keys()].sort()).toEqual(
      [
        "genius-core:distillation-run-now",
        "genius-core:distillation-set-enabled",
        "genius-core:distillation-status",
        "genius-core:export-edit-session",
        "genius-core:flush-edit-log",
        "genius-core:init",
        "genius-core:infer",
        "genius-core:list-base-models",
        "genius-core:load-context-slot",
        "genius-core:open-project-slot",
        "genius-core:peek-project-slot",
        "genius-core:record-edit",
        "genius-core:set-base-model",
        "genius-core:status",
        "genius-core:stream-infer",
      ].sort(),
    );
  });

  it("status() proxies to GeniusCore.status", async () => {
    const out = await call("genius-core:status");
    expect(geniusCoreMock.status).toHaveBeenCalled();
    expect(out).toMatchObject({ status: "uninitialized" });
  });

  it("init() calls init then returns status", async () => {
    await call("genius-core:init");
    expect(geniusCoreMock.init).toHaveBeenCalledTimes(1);
    expect(geniusCoreMock.status).toHaveBeenCalled();
  });

  it("load-context-slot rejects non-string projectId", async () => {
    await expect(call("genius-core:load-context-slot", "")).rejects.toThrow(/projectId/);
    await expect(call("genius-core:load-context-slot", 42)).rejects.toThrow(/projectId/);
  });

  it("infer validates request", async () => {
    await expect(call("genius-core:infer", { prompt: "" })).rejects.toThrow(/prompt/);
    const out = await call("genius-core:infer", { prompt: "hi" });
    expect(out).toMatchObject({ text: "ok" });
  });

  it("stream-infer forwards chunks via event.sender.send", async () => {
    const send = vi.fn();
    const fn = registered.get("genius-core:stream-infer")!;
    const ev = { sender: { isDestroyed: () => false, send } };
    await fn(ev, { prompt: "hi" });
    expect(send).toHaveBeenCalledWith("genius-core:stream-chunk", { chunk: "ok" });
  });

  it("stream-infer skips send when sender is destroyed", async () => {
    const send = vi.fn();
    const fn = registered.get("genius-core:stream-infer")!;
    const ev = { sender: { isDestroyed: () => true, send } };
    await fn(ev, { prompt: "hi" });
    expect(send).not.toHaveBeenCalled();
  });

  it("set-base-model rejects non-string", async () => {
    await expect(call("genius-core:set-base-model", "")).rejects.toThrow(/modelId/);
    await expect(call("genius-core:set-base-model", 5)).rejects.toThrow(/modelId/);
  });

  it("set-base-model rejects unknown id", async () => {
    await expect(call("genius-core:set-base-model", "no-such-model")).rejects.toThrow(
      /Unknown Genius Core base model/,
    );
    expect(writeSettingsMock).not.toHaveBeenCalled();
  });

  it("set-base-model persists known id and triggers shutdown", async () => {
    await call("genius-core:set-base-model", "phi-3-mini-4k-instruct-int4-onnx");
    expect(writeSettingsMock).toHaveBeenCalledTimes(1);
    const arg = writeSettingsMock.mock.calls[0][0] as {
      geniusCore: { baseModelId: string };
    };
    expect(arg.geniusCore.baseModelId).toBe("phi-3-mini-4k-instruct-int4-onnx");
    expect(geniusCoreMock.shutdown).toHaveBeenCalledTimes(1);
  });

  it("set-base-model preserves other geniusCore fields", async () => {
    readSettingsMock.mockReturnValueOnce({
      geniusCore: {
        enabled: true,
        vramBudgetGb: 12,
        baseModelId: "old",
        executionProvider: "webgpu",
        npuOffloadEnabled: true,
        weightStreamingEnabled: true,
        keystrokeLoggerEnabled: false,
        nightlyDistillationEnabled: true,
      },
    });
    await call("genius-core:set-base-model", "phi-3-mini-4k-instruct-int4-onnx");
    const arg = writeSettingsMock.mock.calls[0][0] as { geniusCore: Record<string, unknown> };
    expect(arg.geniusCore).toMatchObject({
      enabled: true,
      vramBudgetGb: 12,
      executionProvider: "webgpu",
      npuOffloadEnabled: true,
      weightStreamingEnabled: true,
      keystrokeLoggerEnabled: false,
      nightlyDistillationEnabled: true,
      baseModelId: "phi-3-mini-4k-instruct-int4-onnx",
    });
  });

  it("list-base-models returns the catalogue mapping", async () => {
    const out = (await call("genius-core:list-base-models")) as Array<{ id: string }>;
    expect(out.length).toBeGreaterThan(0);
    expect(out[0].id).toBe("phi-3-mini-4k-instruct-int4-onnx");
  });
});
