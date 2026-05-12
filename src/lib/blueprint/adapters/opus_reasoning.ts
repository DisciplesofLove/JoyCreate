/**
 * Opus Reasoning adapter — runs an in-process LLM call using the same
 * model client + settings as the rest of the app. Returns the raw text.
 *
 * Params:
 *   prompt:    string (required)
 *   system?:   string
 *   modelId?:  string         — overrides the user's selected model
 *   maxTokens?: number
 *   temperature?: number
 */

import { generateText } from "ai";
import log from "electron-log";
import { getModelClient } from "@/ipc/utils/get_model_client";
import { readSettings } from "@/main/settings";
import type { LargeLanguageModel } from "@/lib/schemas";

const logger = log.scope("blueprint:opus-reasoning");

export interface OpusReasoningParams {
  prompt: string;
  system?: string;
  modelId?: string;
  maxTokens?: number;
  temperature?: number;
}

export async function runOpusReasoning(
  params: Record<string, unknown>,
): Promise<{ text: string; modelId: string }> {
  const p = params as Partial<OpusReasoningParams>;
  if (!p.prompt || typeof p.prompt !== "string") {
    throw new Error("opus-reasoning requires { prompt: string }");
  }

  const settings = readSettings();
  const selectedRaw = (
    settings as { selectedChatModel?: { provider?: string; name?: string } }
  ).selectedChatModel;
  const model: LargeLanguageModel = {
    provider: (selectedRaw?.provider ?? "auto") as LargeLanguageModel["provider"],
    name: p.modelId ?? selectedRaw?.name ?? "claude-sonnet-4-5",
  };

  const { modelClient } = await getModelClient(model, settings);

  const messages: Array<{ role: "system" | "user"; content: string }> = [];
  if (p.system) messages.push({ role: "system", content: p.system });
  messages.push({ role: "user", content: p.prompt });

  const result = await generateText({
    model: modelClient.model,
    messages: messages as unknown as Parameters<typeof generateText>[0]["messages"],
    maxRetries: 1,
    ...(p.maxTokens ? { maxOutputTokens: p.maxTokens } : {}),
    ...(p.temperature !== undefined ? { temperature: p.temperature } : {}),
  });

  const text = (result as { text?: string }).text ?? "";
  logger.info(`opus-reasoning: ${text.length} chars from ${model.name}`);
  return { text, modelId: model.name };
}
