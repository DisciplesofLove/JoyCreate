/**
 * Local router — calls Ollama through the existing local_model_service
 * to classify a plain-English prompt into a CopilotIntent.
 *
 * The router is JSON-mode strict: any unparseable response degrades to a
 * low-confidence chat reply asking the user to clarify.
 */

import log from "electron-log";
import { localModelService } from "@/lib/local_model_service";
import {
  CopilotIntentSchema,
  COPILOT_ROUTER_SYSTEM_PROMPT,
  type CopilotIntent,
} from "./intent_schema";
import { renderToolListForPrompt } from "./tool_registry";
import type { InferenceRequest } from "@/types/trustless_inference";

const logger = log.scope("copilot:local_router");

/** Default Ollama model — overridable via copilot settings. */
const DEFAULT_ROUTER_MODEL = "llama3.1:8b";

export interface RouterOptions {
  /** Ollama model id (e.g. "llama3.1:8b", "qwen2.5:7b"). */
  model?: string;
  /** Lower = more deterministic. */
  temperature?: number;
}

export async function classifyPrompt(
  userPrompt: string,
  options: RouterOptions = {},
): Promise<CopilotIntent> {
  const modelId = options.model ?? DEFAULT_ROUTER_MODEL;
  const systemPrompt = COPILOT_ROUTER_SYSTEM_PROMPT.replace(
    "{TOOL_LIST}",
    renderToolListForPrompt(),
  );

  const request: InferenceRequest = {
    id: `copilot-route-${Date.now()}`,
    prompt: userPrompt,
    systemPrompt,
    modelConfig: {
      provider: "ollama",
      modelId,
      options: {
        temperature: options.temperature ?? 0.1,
        numPredict: 512,
      },
    },
  };

  let raw: string;
  try {
    const response = await localModelService.chat(request);
    raw = response.output ?? "";
  } catch (err) {
    logger.warn("Local router failed, defaulting to chat fallback", err);
    return {
      kind: "chat",
      reply:
        "I couldn't reach the local Ollama model. Make sure Ollama is running and a model like `llama3.1:8b` is pulled.",
      confidence: 0,
      summary: "ollama-unreachable",
    };
  }

  const parsed = parseJsonLoosely(raw);
  if (!parsed) {
    return {
      kind: "chat",
      reply: raw.trim() || "I'm not sure what you mean. Could you rephrase?",
      confidence: 0.3,
      summary: "non-json-response",
    };
  }

  const result = CopilotIntentSchema.safeParse(parsed);
  if (!result.success) {
    logger.warn("Router emitted invalid intent shape", result.error.format());
    return {
      kind: "chat",
      reply:
        "I had trouble understanding that request. Try asking in a different way.",
      confidence: 0.2,
      summary: "schema-validation-failed",
    };
  }

  return result.data;
}

/**
 * Tolerant JSON extractor — local models often wrap JSON in code fences
 * or add a trailing sentence. We strip common decorations and try again.
 */
function parseJsonLoosely(raw: string): unknown {
  const trimmed = raw.trim();
  // Direct parse
  try {
    return JSON.parse(trimmed);
  } catch {
    /* fallthrough */
  }
  // Strip ```json fences
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fence) {
    try {
      return JSON.parse(fence[1]);
    } catch {
      /* fallthrough */
    }
  }
  // Find first { ... } block
  const brace = trimmed.match(/\{[\s\S]*\}/);
  if (brace) {
    try {
      return JSON.parse(brace[0]);
    } catch {
      /* fallthrough */
    }
  }
  return null;
}
