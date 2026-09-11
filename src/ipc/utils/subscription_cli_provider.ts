/**
 * Subscription CLI → ai-sdk `LanguageModelV2` adapter.
 *
 * Wrapping the CLIs in the same contract Ollama and the cloud providers use is
 * what makes this a real provider rather than a special feature: chat streaming,
 * the model picker, agents, the Discord and Telegram bots and every other
 * ai-sdk consumer get subscription models without knowing a subprocess exists.
 *
 * Two honest limitations, surfaced as warnings rather than hidden:
 *
 *   • **No function calling.** These CLIs own their own tool loop; they do not
 *     expose one. A caller that needs tools must use an API-key provider, and
 *     gets a warning saying so instead of a silently toolless answer.
 *   • **Sampling settings are ignored.** `temperature`, `topP` and the rest are
 *     not exposed on the CLIs' headless interfaces, so passing them through
 *     would be a lie.
 */

import type {
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV2CallWarning,
  LanguageModelV2Content,
  LanguageModelV2Prompt,
  LanguageModelV2StreamPart,
  LanguageModelV2Usage,
} from "@ai-sdk/provider";

import { getSubscriptionCli } from "@/lib/subscription_cli/cli_registry";
import { runSubscriptionCli } from "@/lib/subscription_cli/cli_runner";

const TEXT_PART_ID = "subscription-cli-text";

/**
 * Flatten the message array into one prompt string.
 *
 * The CLIs take a single prompt, not a conversation, so the turn structure has
 * to be spelled out in text. Losing it entirely would make every reply ignore
 * the conversation so far.
 */
function flattenPrompt(prompt: LanguageModelV2Prompt): string {
  const sections: string[] = [];

  for (const message of prompt) {
    if (message.role === "system") {
      sections.push(message.content);
      continue;
    }
    if (message.role === "tool") {
      for (const part of message.content) {
        const output =
          typeof part.output === "string"
            ? part.output
            : JSON.stringify(part.output);
        sections.push(`[result of ${part.toolName}]\n${output}`);
      }
      continue;
    }

    const label = message.role === "user" ? "User" : "Assistant";
    const chunks: string[] = [];
    for (const part of message.content) {
      switch (part.type) {
        case "text":
          chunks.push(part.text);
          break;
        case "reasoning":
          // The CLI will do its own thinking; replaying ours is noise.
          break;
        case "file":
          chunks.push(`[attached ${part.mediaType}]`);
          break;
        case "tool-call":
          chunks.push(`[called ${part.toolName}]`);
          break;
        case "tool-result":
          chunks.push(`[result of ${part.toolName}]`);
          break;
        default:
          break;
      }
    }
    const body = chunks.join("").trim();
    if (body) sections.push(`${label}: ${body}`);
  }

  return sections.join("\n\n");
}

function buildWarnings(
  options: LanguageModelV2CallOptions,
  cliLabel: string,
): LanguageModelV2CallWarning[] {
  const warnings: LanguageModelV2CallWarning[] = [];

  for (const tool of options.tools ?? []) {
    warnings.push({
      type: "unsupported-tool",
      tool,
      details:
        `${cliLabel} runs its own tool loop and does not expose function calling. ` +
        `Select an API-key provider for tool use.`,
    });
  }

  for (const setting of [
    "temperature",
    "topP",
    "topK",
    "presencePenalty",
    "frequencyPenalty",
    "seed",
    "stopSequences",
    "responseFormat",
    "toolChoice",
    "maxOutputTokens",
  ] as const) {
    if (options[setting] !== undefined) {
      warnings.push({
        type: "unsupported-setting",
        setting,
        details: `${cliLabel} does not accept ${setting} on its headless interface.`,
      });
    }
  }

  return warnings;
}

function usage(inputTokens: number, outputTokens: number): LanguageModelV2Usage {
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
  };
}

/**
 * Build a language model backed by a locally installed, already-signed-in CLI.
 *
 * `cliId` is the provider id (`claude-cli`, `codex-cli`, …); `modelId` is passed
 * through to the CLI's own model flag.
 */
export function createSubscriptionCliLanguageModel(
  cliId: string,
  modelId: string,
): LanguageModelV2 {
  const def = getSubscriptionCli(cliId);
  if (!def) {
    throw new Error(`Unknown subscription provider: ${cliId}`);
  }

  return {
    specificationVersion: "v2",
    provider: cliId,
    modelId,
    supportedUrls: {},

    async doGenerate(options) {
      const warnings = buildWarnings(options, def.label);
      const result = await runSubscriptionCli({
        cliId,
        prompt: flattenPrompt(options.prompt),
        model: modelId,
        signal: options.abortSignal,
      });

      const content: LanguageModelV2Content[] = [
        { type: "text", text: result.text },
      ];

      return {
        content,
        finishReason: "stop",
        usage: usage(result.inputTokens, result.outputTokens),
        warnings,
        request: { body: undefined },
        response: { modelId },
        providerMetadata: {
          [cliId]: {
            costUsd: result.costUsd,
            billedTo: def.subscription,
          },
        },
      };
    },

    async doStream(options) {
      const warnings = buildWarnings(options, def.label);
      const prompt = flattenPrompt(options.prompt);

      const stream = new ReadableStream<LanguageModelV2StreamPart>({
        async start(controller) {
          controller.enqueue({ type: "stream-start", warnings });
          controller.enqueue({ type: "text-start", id: TEXT_PART_ID });

          try {
            const result = await runSubscriptionCli({
              cliId,
              prompt,
              model: modelId,
              signal: options.abortSignal,
              onText: (delta) => {
                controller.enqueue({
                  type: "text-delta",
                  id: TEXT_PART_ID,
                  delta,
                });
              },
            });

            controller.enqueue({ type: "text-end", id: TEXT_PART_ID });
            controller.enqueue({
              type: "finish",
              finishReason: "stop",
              usage: usage(result.inputTokens, result.outputTokens),
              providerMetadata: {
                [cliId]: {
                  costUsd: result.costUsd,
                  billedTo: def.subscription,
                },
              },
            });
          } catch (error) {
            controller.enqueue({ type: "text-end", id: TEXT_PART_ID });
            controller.enqueue({
              type: "error",
              error:
                error instanceof Error
                  ? error
                  : new Error(String(error ?? `${def.label} failed`)),
            });
            controller.enqueue({
              type: "finish",
              finishReason: "error",
              usage: usage(0, 0),
            });
          }
          controller.close();
        },
      });

      return { stream };
    },
  };
}
