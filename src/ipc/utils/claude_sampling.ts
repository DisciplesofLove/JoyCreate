/**
 * Claude models that reject sampling parameters.
 *
 * From Claude Opus 4.7 onward — and across the whole Claude 5 generation —
 * setting `temperature`, `top_p` or `top_k` to any non-default value returns a
 * 400 error (Anthropic's Opus 5 migration guide, "Sampling parameters
 * removed"). JoyCreate sends a temperature on almost every request: the chat
 * stream resolves one from the model catalog, falling back to 0, and many
 * agents default to 0.7. Without this, every request to a current Claude model
 * fails before it starts.
 *
 * The fix lives at the model client, so every caller is covered at once.
 */

import { wrapLanguageModel } from "ai";
import type { LanguageModelV2 } from "@ai-sdk/provider";

/**
 * Matches Claude model IDs in every form JoyCreate sees them:
 *   claude-opus-5            (Anthropic API)
 *   claude-opus-4-7          (Anthropic API, dashed version)
 *   anthropic/claude-opus-4.7 (OpenRouter, dotted version)
 *   us.anthropic.claude-opus-4-7-v1:0 (Bedrock inference profile)
 */
const CLAUDE_ID = /claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:[-.](\d+))?/i;

export function rejectsSamplingParams(modelId: string | undefined): boolean {
  if (!modelId) return false;
  const match = CLAUDE_ID.exec(modelId);
  if (!match) return false;

  const family = match[1].toLowerCase();
  const major = Number(match[2]);
  let minor = match[3] ? Number(match[3]) : 0;
  // "claude-sonnet-4-20250514": the second number is a date snapshot, not a
  // minor version.
  if (minor >= 100) minor = 0;

  // Fable and Mythos launched after the change; they never accepted them.
  if (family === "fable" || family === "mythos") return true;
  // The whole Claude 5 generation and anything later.
  if (major >= 5) return true;
  // Within Claude 4, only Opus 4.7 and later.
  return family === "opus" && major === 4 && minor >= 7;
}

/**
 * Wrap a model so `temperature`, `topP` and `topK` are dropped for Claude
 * models that reject them. Every other model is returned untouched.
 */
export function withoutRejectedSamplingParams(
  model: LanguageModelV2,
  modelId: string,
): LanguageModelV2 {
  if (!rejectsSamplingParams(modelId)) return model;
  return wrapLanguageModel({
    model,
    middleware: {
      transformParams: async ({ params }) => ({
        ...params,
        temperature: undefined,
        topP: undefined,
        topK: undefined,
      }),
    },
  }) as LanguageModelV2;
}
