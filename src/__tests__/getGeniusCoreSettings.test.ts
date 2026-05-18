/**
 * `getGeniusCoreSettings()` — verifies the legacy → unified migration
 * accessor that lets the rest of the codebase ignore where the config
 * physically lives (top-level `geniusCore` vs `localProviders.geniusCore`).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

vi.mock("node:fs");
vi.mock("node:path");
vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    decryptString: vi.fn(),
  },
}));
vi.mock("@/paths/paths", () => ({
  getUserDataPath: vi.fn(() => "/mock"),
}));

import { getGeniusCoreSettings } from "@/main/settings";

const mockFs = vi.mocked(fs);
const mockPath = vi.mocked(path);

function writeMockSettings(obj: Record<string, unknown>): void {
  mockFs.existsSync.mockReturnValue(true);
  mockFs.readFileSync.mockReturnValue(JSON.stringify(obj) as never);
}

describe("getGeniusCoreSettings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPath.join.mockReturnValue("/mock/user-settings.json");
  });
  afterEach(() => vi.restoreAllMocks());

  it("returns defaults when no Genius Core config exists at either location", () => {
    writeMockSettings({
      selectedModel: { name: "auto", provider: "auto" },
    });
    const cfg = getGeniusCoreSettings();
    expect(cfg.enabled).toBe(false);
    expect(cfg.vramBudgetGb).toBe(8);
    expect(cfg.baseModelId).toBe("phi-3-mini-4k-instruct-int4-onnx");
  });

  it("reads the legacy top-level geniusCore block when present", () => {
    writeMockSettings({
      selectedModel: { name: "auto", provider: "auto" },
      geniusCore: {
        enabled: true,
        vramBudgetGb: 16,
        baseModelId: "llama-3.2-1b-instruct-int4-onnx",
        executionProvider: "cuda",
        npuOffloadEnabled: false,
        weightStreamingEnabled: false,
        keystrokeLoggerEnabled: false,
        nightlyDistillationEnabled: false,
      },
    });
    const cfg = getGeniusCoreSettings();
    expect(cfg.enabled).toBe(true);
    expect(cfg.vramBudgetGb).toBe(16);
    expect(cfg.executionProvider).toBe("cuda");
    expect(cfg.baseModelId).toBe("llama-3.2-1b-instruct-int4-onnx");
  });

  it("prefers localProviders.geniusCore over the legacy block when both exist", () => {
    writeMockSettings({
      selectedModel: { name: "auto", provider: "auto" },
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
      localProviders: {
        geniusCore: {
          enabled: true,
          executionProvider: "webgpu",
        },
      },
    });
    const cfg = getGeniusCoreSettings();
    // New block wins on overlapping keys...
    expect(cfg.enabled).toBe(true);
    expect(cfg.executionProvider).toBe("webgpu");
    // ...but unspecified new-block keys fall through to legacy.
    expect(cfg.baseModelId).toBe("phi-3-mini-4k-instruct-int4-onnx");
    expect(cfg.vramBudgetGb).toBe(8);
  });

  it("threads toolCallFallback through the merge", () => {
    writeMockSettings({
      selectedModel: { name: "auto", provider: "auto" },
      localProviders: {
        geniusCore: {
          enabled: true,
          toolCallFallback: {
            provider: "ollama",
            modelName: "qwen2.5-coder:7b",
          },
        },
      },
    });
    const cfg = getGeniusCoreSettings();
    expect(cfg.toolCallFallback).toEqual({
      provider: "ollama",
      modelName: "qwen2.5-coder:7b",
    });
  });
});
