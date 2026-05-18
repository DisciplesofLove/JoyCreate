/**
 * Tests for `createGeniusCoreLanguageModel` — the LanguageModelV2 adapter
 * that lets the chat pipeline call Genius Core through the same ai-sdk
 * contract used by Ollama/LMStudio/cloud providers.
 *
 * Each test mocks the `GeniusCore` singleton so we can assert request
 * shaping (prompt flattening, projectId threading) and verify the V2
 * stream-part sequence emitted by `doStream`.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import type { LanguageModelV2StreamPart } from "@ai-sdk/provider";

const hoisted = vi.hoisted(() => ({
  infer: vi.fn(),
  streamInfer: vi.fn(),
}));

vi.mock("@/lib/genius_core", () => ({
  GeniusCore: {
    infer: hoisted.infer,
    streamInfer: hoisted.streamInfer,
  },
}));

import { createGeniusCoreLanguageModel } from "../genius_core_provider";

async function readStream(
  stream: ReadableStream<LanguageModelV2StreamPart>,
): Promise<LanguageModelV2StreamPart[]> {
  const reader = stream.getReader();
  const out: LanguageModelV2StreamPart[] = [];
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    out.push(value);
  }
  return out;
}

describe("createGeniusCoreLanguageModel", () => {
  beforeEach(() => {
    hoisted.infer.mockReset();
    hoisted.streamInfer.mockReset();
  });

  it("exposes the v2 spec and provider identity", () => {
    const model = createGeniusCoreLanguageModel("phi-3-mini");
    expect(model.specificationVersion).toBe("v2");
    expect(model.provider).toBe("genius-core");
    expect(model.modelId).toBe("phi-3-mini");
  });

  it("doGenerate flattens the prompt and returns text content + usage", async () => {
    hoisted.infer.mockResolvedValue({
      text: "Hello there.",
      tokensIn: 12,
      tokensOut: 4,
      durationMs: 50,
      executionProvider: "cpu",
      usedShardStream: false,
    });
    const model = createGeniusCoreLanguageModel("phi-3-mini");
    const result = await model.doGenerate({
      prompt: [
        { role: "system", content: "Be terse." },
        { role: "user", content: [{ type: "text", text: "Hi" }] },
      ],
    });
    expect(hoisted.infer).toHaveBeenCalledOnce();
    const passed = hoisted.infer.mock.calls[0][0];
    expect(passed.prompt).toContain("System: Be terse.");
    expect(passed.prompt).toContain("User: Hi");
    expect(passed.prompt.trim().endsWith("Assistant:")).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: "Hello there." }]);
    expect(result.finishReason).toBe("stop");
    expect(result.usage.inputTokens).toBe(12);
    expect(result.usage.outputTokens).toBe(4);
    expect(result.usage.totalTokens).toBe(16);
  });

  it("doGenerate threads providerOptions['genius-core'].projectId into the request", async () => {
    hoisted.infer.mockResolvedValue({
      text: "ok",
      tokensIn: 0,
      tokensOut: 0,
      durationMs: 0,
      executionProvider: "cpu",
      usedShardStream: false,
    });
    const model = createGeniusCoreLanguageModel("phi-3-mini");
    await model.doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "x" }] }],
      providerOptions: { "genius-core": { projectId: "proj-42" } },
    });
    const passed = hoisted.infer.mock.calls[0][0];
    expect(passed.projectId).toBe("proj-42");
  });

  it("doGenerate emits unsupported-tool warnings when tools are supplied", async () => {
    hoisted.infer.mockResolvedValue({
      text: "ok",
      tokensIn: 0,
      tokensOut: 0,
      durationMs: 0,
      executionProvider: "cpu",
      usedShardStream: false,
    });
    const model = createGeniusCoreLanguageModel("phi-3-mini");
    const result = await model.doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "x" }] }],
      tools: [
        {
          type: "function",
          name: "search",
          inputSchema: { type: "object", properties: {} },
        },
      ],
    });
    expect(result.warnings.some((w) => w.type === "unsupported-tool")).toBe(
      true,
    );
  });

  it("doStream emits stream-start, text-start, text-deltas, text-end, finish in order", async () => {
    hoisted.streamInfer.mockImplementation(
      async (_req: unknown, onChunk: (c: string) => void) => {
        onChunk("Hel");
        onChunk("lo");
        return {
          text: "Hello",
          tokensIn: 2,
          tokensOut: 1,
          durationMs: 10,
          executionProvider: "cpu",
          usedShardStream: false,
        };
      },
    );
    const model = createGeniusCoreLanguageModel("phi-3-mini");
    const { stream } = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    });
    const parts = await readStream(stream);
    const types = parts.map((p) => p.type);
    expect(types[0]).toBe("stream-start");
    expect(types[1]).toBe("text-start");
    expect(types).toContain("text-delta");
    expect(types[types.length - 2]).toBe("text-end");
    expect(types[types.length - 1]).toBe("finish");
    const deltas = parts.filter((p) => p.type === "text-delta");
    expect(deltas.map((d: any) => d.delta).join("")).toBe("Hello");
  });

  it("doStream emits an error part + finish='error' when streamInfer throws", async () => {
    hoisted.streamInfer.mockRejectedValue(new Error("backend unavailable"));
    const model = createGeniusCoreLanguageModel("phi-3-mini");
    const { stream } = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    });
    const parts = await readStream(stream);
    const errorPart = parts.find((p) => p.type === "error") as
      | { type: "error"; error: unknown }
      | undefined;
    expect(errorPart).toBeDefined();
    expect((errorPart!.error as Error).message).toBe("backend unavailable");
    const finishPart = parts.find((p) => p.type === "finish") as any;
    expect(finishPart.finishReason).toBe("error");
  });
});
