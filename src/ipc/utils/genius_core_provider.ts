/**
 * Genius Core → ai-sdk LanguageModelV2 adapter.
 *
 * Bridges JoyCreate's bespoke Genius Core inference singleton into the
 * same `LanguageModelV2` contract used by Ollama/LMStudio/cloud providers,
 * so the existing chat dispatch in `chat_stream_handlers.ts` (and any
 * other ai-sdk consumer) can call Genius Core without special-casing.
 *
 * Contract notes:
 *   • Genius Core only speaks plain prompts today — we flatten the
 *     V2 prompt array (system + user/assistant text parts) into a single
 *     string. Non-text parts (files, tool calls, tool results) become
 *     `[file: type]` / `[tool call: name]` placeholders so the model at
 *     least sees that something existed.
 *   • Function tools are not supported. We emit `unsupported-tool`
 *     warnings rather than throwing; the dispatch layer handles the
 *     tool-call fallback to a capable model (Phase 3).
 *   • The Genius Core `projectId` (used to layer a per-project context
 *     slot) can be threaded through via
 *     `providerOptions["genius-core"].projectId` on the call options.
 *   • Streaming bridges the `(chunk: string) => void` callback into a
 *     V2 `text-start` → `text-delta`* → `text-end` → `finish` sequence.
 */

import type {
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV2CallWarning,
  LanguageModelV2Content,
  LanguageModelV2FinishReason,
  LanguageModelV2Prompt,
  LanguageModelV2StreamPart,
  LanguageModelV2Usage,
} from "@ai-sdk/provider";

import { GeniusCore, type GeniusCoreInferRequest } from "@/lib/genius_core";

const TEXT_PART_ID = "genius-core-text";

function flattenPrompt(prompt: LanguageModelV2Prompt): string {
  const lines: string[] = [];
  for (const message of prompt) {
    if (message.role === "system") {
      lines.push(`System: ${message.content}`);
      continue;
    }
    if (message.role === "tool") {
      for (const part of message.content) {
        const result =
          typeof part.output === "string"
            ? part.output
            : JSON.stringify(part.output);
        lines.push(`Tool result (${part.toolName}): ${result}`);
      }
      continue;
    }
    const prefix = message.role === "user" ? "User" : "Assistant";
    const chunks: string[] = [];
    for (const part of message.content) {
      switch (part.type) {
        case "text":
          chunks.push(part.text);
          break;
        case "reasoning":
          chunks.push(`(reasoning) ${part.text}`);
          break;
        case "file":
          chunks.push(`[file: ${part.mediaType}]`);
          break;
        case "tool-call":
          chunks.push(`[tool call: ${part.toolName}]`);
          break;
        case "tool-result":
          chunks.push(`[tool result: ${part.toolName}]`);
          break;
        default: {
          // Unknown part type — keep the model unaware rather than throw.
          chunks.push("");
        }
      }
    }
    lines.push(`${prefix}: ${chunks.join("").trim()}`);
  }
  // Genius Core models are completion-style; nudge them toward an
  // assistant turn so they produce a reply.
  lines.push("Assistant:");
  return lines.join("\n\n");
}

function buildRequest(
  modelId: string,
  options: LanguageModelV2CallOptions,
): { request: GeniusCoreInferRequest; warnings: LanguageModelV2CallWarning[] } {
  const warnings: LanguageModelV2CallWarning[] = [];
  if (options.tools && options.tools.length > 0) {
    for (const tool of options.tools) {
      warnings.push({
        type: "unsupported-tool",
        tool,
        details:
          "Genius Core does not support native function calling; use the tool-call fallback model.",
      });
    }
  }
  for (const setting of [
    "topP",
    "topK",
    "presencePenalty",
    "frequencyPenalty",
    "seed",
    "stopSequences",
    "responseFormat",
    "toolChoice",
  ] as const) {
    if (options[setting] !== undefined) {
      warnings.push({
        type: "unsupported-setting",
        setting,
        details: `Genius Core ignores ${setting}.`,
      });
    }
  }

  const providerOptions =
    (options.providerOptions?.["genius-core"] as
      | { projectId?: string }
      | undefined) ?? undefined;

  const request: GeniusCoreInferRequest = {
    prompt: flattenPrompt(options.prompt),
    maxTokens: options.maxOutputTokens,
    temperature: options.temperature,
    projectId: providerOptions?.projectId,
  };
  // Tag the request with the picker-selected modelId so the backend can
  // hot-swap bases when this differs from the currently loaded one.
  // (No-op until the backend honors it; safe to attach.)
  (request as GeniusCoreInferRequest & { baseModelId?: string }).baseModelId =
    modelId;
  return { request, warnings };
}

function makeUsage(tokensIn: number, tokensOut: number): LanguageModelV2Usage {
  return {
    inputTokens: tokensIn,
    outputTokens: tokensOut,
    totalTokens: tokensIn + tokensOut,
  };
}

/**
 * Build an ai-sdk-compatible LanguageModelV2 backed by the Genius Core
 * singleton. The returned object is stateless; per-call state lives on
 * the singleton (loaded base + context slots).
 */
export function createGeniusCoreLanguageModel(
  modelId: string,
): LanguageModelV2 {
  return {
    specificationVersion: "v2",
    provider: "genius-core",
    modelId,
    supportedUrls: {},

    async doGenerate(options) {
      const { request, warnings } = buildRequest(modelId, options);
      const response = await GeniusCore.infer(request);
      const content: LanguageModelV2Content[] = [
        { type: "text", text: response.text },
      ];
      const finishReason: LanguageModelV2FinishReason = "stop";
      return {
        content,
        finishReason,
        usage: makeUsage(response.tokensIn, response.tokensOut),
        warnings,
        response: {
          modelId,
        },
        providerMetadata: {
          "genius-core": {
            executionProvider: response.executionProvider,
            usedShardStream: response.usedShardStream,
            durationMs: response.durationMs,
          },
        },
      };
    },

    async doStream(options) {
      const { request, warnings } = buildRequest(modelId, options);
      const stream = new ReadableStream<LanguageModelV2StreamPart>({
        async start(controller) {
          controller.enqueue({ type: "stream-start", warnings });
          controller.enqueue({ type: "text-start", id: TEXT_PART_ID });
          try {
            const response = await GeniusCore.streamInfer(request, (chunk) => {
              if (chunk.length > 0) {
                controller.enqueue({
                  type: "text-delta",
                  id: TEXT_PART_ID,
                  delta: chunk,
                });
              }
            });
            controller.enqueue({ type: "text-end", id: TEXT_PART_ID });
            controller.enqueue({
              type: "finish",
              finishReason: "stop",
              usage: makeUsage(response.tokensIn, response.tokensOut),
              providerMetadata: {
                "genius-core": {
                  executionProvider: response.executionProvider,
                  usedShardStream: response.usedShardStream,
                  durationMs: response.durationMs,
                },
              },
            });
            controller.close();
          } catch (error) {
            controller.enqueue({ type: "text-end", id: TEXT_PART_ID });
            controller.enqueue({
              type: "error",
              error:
                error instanceof Error
                  ? error
                  : new Error(
                      typeof error === "string"
                        ? error
                        : "Genius Core inference failed",
                    ),
            });
            controller.enqueue({
              type: "finish",
              finishReason: "error",
              usage: makeUsage(0, 0),
            });
            controller.close();
          }
        },
      });
      return { stream };
    },
  };
}
