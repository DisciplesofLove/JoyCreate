/**
 * trustless_streaming — push-based streaming generator.
 *
 * Proves `streamVerifiedInference` relays each provider chunk to the consumer
 * the moment it arrives (no polling) and terminates with a single `done`,
 * even when the provider emits several chunks in one synchronous burst.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("electron-log", () => ({
  default: {
    scope: () => ({ info: () => undefined, warn: () => undefined, error: () => undefined }),
  },
}));

vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/db/playground_chat_schema", () => ({
  playgroundConversations: {},
  playgroundMessages: {},
}));

vi.mock("@/lib/helia_verification_service", () => ({
  heliaVerificationService: {
    start: vi.fn(),
    stop: vi.fn(),
    listInferenceRecords: vi.fn().mockResolvedValue([]),
    createInferenceProof: vi.fn(),
    storeInferenceRecord: vi.fn(),
  },
}));

vi.mock("@/lib/local_model_service", () => ({
  localModelService: {
    streamChat: vi.fn(),
    // Returning null means verification is skipped, so the generator finishes
    // on the stream alone — exactly what we want to assert here.
    getModelInfo: vi.fn().mockResolvedValue(null),
  },
}));

import { localModelService } from "@/lib/local_model_service";
import { trustlessInferenceService } from "@/lib/trustless_inference_service";

const streamChat = vi.mocked(localModelService.streamChat);

describe("streamVerifiedInference (push-based)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(localModelService.getModelInfo).mockResolvedValue(null);
  });

  it("yields each chunk in order followed by a single done", async () => {
    streamChat.mockImplementation(async (_req, onChunk) => {
      for (const c of ["Hello", ", ", "world"]) onChunk(c);
      return {
        id: "r1",
        requestId: "q1",
        modelInfo: { id: "m", name: "m", provider: "ollama" },
        output: "Hello, world",
        promptTokens: 1,
        completionTokens: 3,
        totalTokens: 4,
        generationTimeMs: 5,
        timestamp: Date.now(),
        finishReason: "stop",
      };
    });

    const tokens: string[] = [];
    let doneCount = 0;
    for await (const ev of trustlessInferenceService.streamVerifiedInference(
      "ollama",
      "test-model",
      [{ role: "user", content: "hi" }],
    )) {
      if (ev.type === "token") tokens.push(ev.content);
      else doneCount++;
    }

    expect(tokens).toEqual(["Hello", ", ", "world"]);
    expect(doneCount).toBe(1);
  });

  it("drains chunks emitted across async delays without loss", async () => {
    streamChat.mockImplementation(async (_req, onChunk) => {
      onChunk("a");
      await new Promise((r) => setTimeout(r, 5));
      onChunk("b");
      await new Promise((r) => setTimeout(r, 5));
      onChunk("c");
      return {
        id: "r2",
        requestId: "q2",
        modelInfo: { id: "m", name: "m", provider: "ollama" },
        output: "abc",
        promptTokens: 0,
        completionTokens: 3,
        totalTokens: 3,
        generationTimeMs: 1,
        timestamp: Date.now(),
        finishReason: "stop",
      };
    });

    const tokens: string[] = [];
    for await (const ev of trustlessInferenceService.streamVerifiedInference(
      "ollama",
      "test-model",
      [{ role: "user", content: "hi" }],
    )) {
      if (ev.type === "token") tokens.push(ev.content);
    }

    expect(tokens.join("")).toBe("abc");
  });

  it("surfaces provider failures as a thrown error", async () => {
    streamChat.mockRejectedValue(new Error("Ollama stream failed: model not found"));

    const iterate = async () => {
      for await (const _ev of trustlessInferenceService.streamVerifiedInference(
        "ollama",
        "missing-model",
        [{ role: "user", content: "hi" }],
      )) {
        // drain
      }
    };

    await expect(iterate()).rejects.toThrow(/model not found/);
  });
});
