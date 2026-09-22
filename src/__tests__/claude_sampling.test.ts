/**
 * Current Claude models return a 400 for any non-default temperature, top_p or
 * top_k. JoyCreate sends a temperature on nearly every request, so a model ID
 * this misclassifies either fails every call or silently loses sampling control
 * on a model that still supports it.
 */

import { describe, expect, it } from "vitest";
import type { LanguageModelV2, LanguageModelV2CallOptions } from "@ai-sdk/provider";

import {
  rejectsSamplingParams,
  withoutRejectedSamplingParams,
} from "@/ipc/utils/claude_sampling";

describe("which Claude models reject sampling parameters", () => {
  it("rejects for the current lineup", () => {
    expect(rejectsSamplingParams("claude-opus-5")).toBe(true);
    expect(rejectsSamplingParams("claude-sonnet-5")).toBe(true);
    expect(rejectsSamplingParams("claude-fable-5-1")).toBe(true);
  });

  it("rejects for Opus 4.7 and 4.8, where the change began", () => {
    expect(rejectsSamplingParams("claude-opus-4-7")).toBe(true);
    expect(rejectsSamplingParams("claude-opus-4-8")).toBe(true);
  });

  it("still allows them on models that accept them", () => {
    expect(rejectsSamplingParams("claude-haiku-4-5")).toBe(false);
    expect(rejectsSamplingParams("claude-haiku-4-5-20251001")).toBe(false);
    expect(rejectsSamplingParams("claude-sonnet-4-6")).toBe(false);
    expect(rejectsSamplingParams("claude-opus-4-6")).toBe(false);
    expect(rejectsSamplingParams("claude-sonnet-4-5-20250929")).toBe(false);
  });

  it("does not read a date snapshot as a minor version", () => {
    // claude-opus-4-20250514 is Opus 4.0, not "Opus 4.20250514".
    expect(rejectsSamplingParams("claude-opus-4-20250514")).toBe(false);
  });

  it("recognises OpenRouter and Bedrock forms of the same models", () => {
    expect(rejectsSamplingParams("anthropic/claude-opus-4.7")).toBe(true);
    expect(rejectsSamplingParams("anthropic/claude-sonnet-4.6")).toBe(false);
    expect(rejectsSamplingParams("us.anthropic.claude-opus-4-7-v1:0")).toBe(true);
    expect(rejectsSamplingParams("anthropic.claude-opus-5")).toBe(true);
  });

  it("leaves non-Claude models alone", () => {
    for (const id of ["gpt-5.6-sol", "gemini-3.8-flash", "grok-4.6", "", undefined]) {
      expect(rejectsSamplingParams(id)).toBe(false);
    }
  });
});

describe("stripping them at the model client", () => {
  function recordingModel(): { model: LanguageModelV2; seen: LanguageModelV2CallOptions[] } {
    const seen: LanguageModelV2CallOptions[] = [];
    const model: LanguageModelV2 = {
      specificationVersion: "v2",
      provider: "test",
      modelId: "test",
      supportedUrls: {},
      async doGenerate(options) {
        seen.push(options);
        return {
          content: [{ type: "text", text: "ok" }],
          finishReason: "stop",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          warnings: [],
        };
      },
      async doStream(options) {
        seen.push(options);
        return { stream: new ReadableStream() };
      },
    };
    return { model, seen };
  }

  const call = (temperature: number) =>
    ({
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      temperature,
      topP: 0.9,
      topK: 40,
    }) as LanguageModelV2CallOptions;

  it("removes temperature, topP and topK for a model that rejects them", async () => {
    const { model, seen } = recordingModel();
    await withoutRejectedSamplingParams(model, "claude-opus-5").doGenerate(call(0));

    expect(seen[0].temperature).toBeUndefined();
    expect(seen[0].topP).toBeUndefined();
    expect(seen[0].topK).toBeUndefined();
    // Everything else must pass through untouched.
    expect(seen[0].prompt).toEqual(call(0).prompt);
  });

  it("passes them through for a model that accepts them", async () => {
    const { model, seen } = recordingModel();
    const wrapped = withoutRejectedSamplingParams(model, "claude-haiku-4-5");

    expect(wrapped).toBe(model);
    await wrapped.doGenerate(call(0.3));
    expect(seen[0].temperature).toBe(0.3);
    expect(seen[0].topK).toBe(40);
  });
});
