import { PROVIDERS_THAT_SUPPORT_THINKING } from "../shared/language_model_constants";
import type { UserSettings } from "../../lib/schemas";

export type ReasoningEffort = "low" | "medium" | "high" | "ultra";

/**
 * Resolve the active reasoning effort preset, falling back to the legacy
 * `thinkingBudget` setting and finally "medium".
 */
export function getReasoningEffort(
  settings: UserSettings | undefined,
): ReasoningEffort {
  return (settings?.reasoningEffort ??
    settings?.thinkingBudget ??
    "medium") as ReasoningEffort;
}

function getThinkingBudgetTokens(effort: ReasoningEffort): number {
  switch (effort) {
    case "low":
      return 1_000;
    case "medium":
      return 4_000;
    case "high":
      return 16_000;
    case "ultra":
      return -1; // -1 = dynamic/maximum thinking, model determines the budget.
    default:
      return 4_000; // Default to medium
  }
}

// OpenAI reasoning models only accept low/medium/high.
function getOpenAiReasoningEffort(
  effort: ReasoningEffort,
): "low" | "medium" | "high" {
  return effort === "ultra" ? "high" : effort;
}

export function getExtraProviderOptions(
  providerId: string | undefined,
  settings: UserSettings,
): Record<string, any> {
  if (!providerId) {
    return {};
  }
  const effort = getReasoningEffort(settings);
  if (providerId === "openai") {
    return {
      reasoning_effort: getOpenAiReasoningEffort(effort),
    };
  }
  if (PROVIDERS_THAT_SUPPORT_THINKING.includes(providerId)) {
    const budgetTokens = getThinkingBudgetTokens(effort);
    return {
      thinking: {
        type: "enabled",
        include_thoughts: true,
        // -1 means dynamic thinking where model determines.
        // budget_tokens: 128, // minimum for Gemini Pro is 128
        budget_tokens: budgetTokens,
      },
    };
  }
  return {};
}
