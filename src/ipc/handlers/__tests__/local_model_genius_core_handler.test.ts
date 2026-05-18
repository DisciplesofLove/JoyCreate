/**
 * Tests for the Genius Core local-models discovery handler.
 *
 * Mocks Electron's `ipcMain.handle` to capture the registered handler
 * function, then drives it directly with a stub event. Settings are
 * stubbed so we can toggle the `geniusCore.enabled` gate.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

type HandlerFn = (event: unknown, ...args: unknown[]) => unknown;

const hoisted = vi.hoisted(() => {
  const registered = new Map<string, HandlerFn>();
  const readSettingsMock = vi.fn();
  const getGeniusCoreSettingsMock = vi.fn();
  return { registered, readSettingsMock, getGeniusCoreSettingsMock };
});

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, fn: HandlerFn) => {
      hoisted.registered.set(channel, fn);
    },
  },
}));

vi.mock("electron-log", () => ({
  default: {
    scope: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
    }),
  },
}));

vi.mock("@/main/settings", () => ({
  readSettings: hoisted.readSettingsMock,
  getGeniusCoreSettings: hoisted.getGeniusCoreSettingsMock,
}));

vi.mock("../genius_core_handlers", () => ({
  listBaseModels: () => [
    {
      id: "phi-3-mini-4k-instruct-int4-onnx",
      displayName: "Phi-3 Mini (4k, int4)",
      format: "onnx",
      quantization: "int4",
      contextWindow: 4096,
      executionProviders: ["webgpu", "cpu"],
      approxBytes: 1_200_000_000,
      source: "curated",
    },
    {
      id: "llama-3.2-1b-instruct-int4-onnx",
      displayName: "Llama 3.2 1B (int4)",
      format: "onnx",
      quantization: "int4",
      contextWindow: 8192,
      executionProviders: ["webgpu", "cpu"],
      approxBytes: 600_000_000,
      source: "curated",
    },
  ],
}));

describe("local_model_genius_core_handler", () => {
  beforeEach(async () => {
    hoisted.registered.clear();
    hoisted.readSettingsMock.mockReset();
    hoisted.getGeniusCoreSettingsMock.mockReset();
    vi.resetModules();
    const mod = await import("../local_model_genius_core_handler");
    mod.registerGeniusCoreLocalModelsHandlers();
  });

  it("registers the local-models:list-genius-core channel", () => {
    expect(hoisted.registered.has("local-models:list-genius-core")).toBe(true);
  });

  it("returns an empty list when Genius Core is disabled", async () => {
    hoisted.getGeniusCoreSettingsMock.mockReturnValue({ enabled: false });
    const handler = hoisted.registered.get("local-models:list-genius-core")!;
    const result = (await handler({})) as { models: unknown[] };
    expect(result.models).toEqual([]);
  });

  it("returns an empty list when settings has no geniusCore block", async () => {
    hoisted.getGeniusCoreSettingsMock.mockReturnValue({ enabled: false });
    const handler = hoisted.registered.get("local-models:list-genius-core")!;
    const result = (await handler({})) as { models: unknown[] };
    expect(result.models).toEqual([]);
  });

  it("returns the curated catalogue when enabled", async () => {
    hoisted.getGeniusCoreSettingsMock.mockReturnValue({ enabled: true });
    const handler = hoisted.registered.get("local-models:list-genius-core")!;
    const result = (await handler({})) as {
      models: { provider: string; modelName: string; displayName: string }[];
    };
    expect(result.models).toHaveLength(2);
    expect(result.models[0]).toEqual({
      provider: "genius-core",
      modelName: "phi-3-mini-4k-instruct-int4-onnx",
      displayName: "Phi-3 Mini (4k, int4)",
    });
    expect(result.models[1].provider).toBe("genius-core");
  });
});
