/**
 * Real agent invoker for the API gateway.
 *
 * Resolves an endpoint's `agentId` to a row in the `agents` table, then
 * runs a `generateText` call via the shared model client. Returns the
 * plain text response plus output-token usage so the gateway can bill.
 *
 * Input shapes accepted (via the request body's `input` field):
 *   - string                            → treated as the user prompt
 *   - { prompt: string, system?, ... }  → structured request
 *   - { messages: ChatMessage[], ... }  → multi-turn chat
 *
 * Per-endpoint `configJson` can supply defaults (system prompt template,
 * model id, temperature, maxTokens). Per-request fields win over endpoint
 * config; endpoint config wins over the agent row defaults.
 */

import { generateText } from "ai";
import log from "electron-log";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { getModelClient } from "@/ipc/utils/get_model_client";
import { readSettings } from "@/main/settings";
import type { LargeLanguageModel } from "@/lib/schemas";
import { setAgentInvoker, type AgentInvoker } from "./service";

const logger = log.scope("api_gateway:invoker");

type ChatMsg = { role: "system" | "user" | "assistant"; content: string };

interface NormalizedRequest {
  system?: string;
  messages: ChatMsg[];
  modelId?: string;
  temperature?: number;
  maxTokens?: number;
}

function asNumber(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return undefined;
}

function asString(v: unknown): string | undefined {
  if (typeof v === "string" && v.length > 0) return v;
  return undefined;
}

function normalizeInput(
  input: unknown,
  config: Record<string, unknown> | null,
): NormalizedRequest {
  const cfg = config ?? {};
  const base: NormalizedRequest = {
    system: asString((cfg as Record<string, unknown>).system),
    messages: [],
    modelId: asString((cfg as Record<string, unknown>).modelId),
    temperature: asNumber((cfg as Record<string, unknown>).temperature),
    maxTokens: asNumber((cfg as Record<string, unknown>).maxTokens),
  };

  if (typeof input === "string") {
    base.messages = [{ role: "user", content: input }];
    return base;
  }

  if (input && typeof input === "object") {
    const obj = input as Record<string, unknown>;
    if (asString(obj.system)) base.system = asString(obj.system);
    if (asString(obj.modelId)) base.modelId = asString(obj.modelId);
    if (asNumber(obj.temperature) !== undefined)
      base.temperature = asNumber(obj.temperature);
    if (asNumber(obj.maxTokens) !== undefined)
      base.maxTokens = asNumber(obj.maxTokens);

    if (Array.isArray(obj.messages)) {
      base.messages = obj.messages
        .filter((m): m is ChatMsg =>
          !!m &&
          typeof m === "object" &&
          typeof (m as ChatMsg).content === "string" &&
          ["system", "user", "assistant"].includes((m as ChatMsg).role),
        )
        .map((m) => ({ role: m.role, content: m.content }));
      return base;
    }
    if (asString(obj.prompt)) {
      base.messages = [{ role: "user", content: asString(obj.prompt)! }];
      return base;
    }
  }

  throw new Error(
    "Invalid input: send a string, { prompt: string }, or { messages: [...] }.",
  );
}

const realInvoker: AgentInvoker = async ({
  endpointId,
  agentId,
  slug,
  config,
  input,
}) => {
  // 1. Resolve agent row (if any) to fetch its defaults.
  let agentRow:
    | {
        systemPrompt: string | null;
        modelId: string | null;
        temperature: number | null;
        maxTokens: number | null;
      }
    | null = null;
  if (agentId != null) {
    const rows = await db
      .select({
        systemPrompt: agents.systemPrompt,
        modelId: agents.modelId,
        temperature: agents.temperature,
        maxTokens: agents.maxTokens,
      })
      .from(agents)
      .where(eq(agents.id, agentId))
      .limit(1);
    if (rows.length === 0) {
      throw new Error(`Agent ${agentId} bound to endpoint ${slug} not found`);
    }
    agentRow = rows[0];
  }

  // 2. Build the request.
  const req = normalizeInput(input, config);
  const system = req.system ?? agentRow?.systemPrompt ?? undefined;
  // Drizzle stores temperature as integer — agent UI persists it scaled
  // (e.g. 70 = 0.7). Treat values > 2 as scaled by 100; pass through small
  // decimals untouched.
  let temperature = req.temperature;
  if (temperature === undefined && agentRow?.temperature != null) {
    temperature =
      agentRow.temperature > 2
        ? agentRow.temperature / 100
        : agentRow.temperature;
  }
  const maxTokens = req.maxTokens ?? agentRow?.maxTokens ?? undefined;
  const modelId = req.modelId ?? agentRow?.modelId ?? undefined;

  // 3. Resolve the model client (re-use the app's selected provider).
  const settings = readSettings();
  const selectedRaw = (
    settings as { selectedChatModel?: { provider?: string; name?: string } }
  ).selectedChatModel;
  const llm: LargeLanguageModel = {
    provider: (selectedRaw?.provider ?? "auto") as LargeLanguageModel["provider"],
    name: modelId ?? selectedRaw?.name ?? "claude-sonnet-4-5",
  };
  const { modelClient } = await getModelClient(llm, settings);

  const messages: ChatMsg[] = [];
  if (system) messages.push({ role: "system", content: system });
  messages.push(...req.messages);

  logger.info(
    `endpoint=${endpointId} slug=${slug} agent=${agentId ?? "none"} model=${llm.name} msgs=${messages.length}`,
  );

  const result = await generateText({
    model: modelClient.model,
    messages: messages as unknown as Parameters<typeof generateText>[0]["messages"],
    maxRetries: 1,
    ...(maxTokens ? { maxOutputTokens: maxTokens } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
  });

  const text = (result as { text?: string }).text ?? "";
  // ai-sdk v5 uses { inputTokens, outputTokens }; older versions used
  // { promptTokens, completionTokens }. Support both.
  const usage = (result as { usage?: Record<string, number | undefined> })
    .usage ?? {};
  const outputTokens =
    usage.outputTokens ?? usage.completionTokens ?? 0;

  return {
    output: {
      text,
      model: llm.name,
      finishReason: (result as { finishReason?: string }).finishReason,
    },
    outputTokens,
  };
};

let installed = false;

/** Wires the real LLM-backed invoker into the gateway. Idempotent. */
export function installAgentInvoker(): void {
  if (installed) return;
  installed = true;
  setAgentInvoker(realInvoker);
  logger.info("real agent invoker installed");
}
