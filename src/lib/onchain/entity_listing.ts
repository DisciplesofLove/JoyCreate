/**
 * LRA glue — convert a local *agent* row into the on-chain `AuthorSkillInput`
 * consumed by LR11 (`publishSkillToAgent`), and resolve the listable agent for
 * higher-level entities (apps) that own an agent.
 *
 * Companion to `skill_listing.ts` (which handles `skills` rows). Together they
 * let any runtime-bearing local entity be published as a Licensed Runtime Asset:
 *
 *   skill → skillRowToAuthorInput        (skill_listing.ts)
 *   agent → agentRowToAuthorInput        (here — prompt-agent from systemPrompt)
 *   app   → its owning agent → agentRowToAuthorInput
 *
 * Pure + side-effect free so it is trivially unit-testable.
 */

import type { agents } from "@/db/schema";
import type { AuthorSkillInput } from "@/lib/onchain/skill_authoring";

/** A row from the local `agents` table. */
export type AgentRow = typeof agents.$inferSelect;

/** Runtime-bearing local entity kinds that can be listed as an LRA. */
export type RuntimeEntityKind = "skill" | "agent" | "app";

/** Caller-supplied overrides the agent row cannot carry on its own. */
export interface AgentListingOptions {
  /** Override the model id (defaults to the agent's own `modelId`). */
  modelId?: string;
  /** Override the system prompt (defaults to the agent's own `systemPrompt`). */
  systemPrompt?: string;
  /** Optional user-prompt template; `{{input}}` is substituted at runtime. */
  promptTemplate?: string;
  maxTokens?: number;
  temperature?: number;
}

/** Trimmed string or undefined (never an empty string). */
function clean(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Clamp a stored 0–100/0–2 temperature-ish integer to the runtime's [0,2] range. */
function normalizeTemperature(raw: number | null | undefined): number | undefined {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return undefined;
  // Agents store temperature as an integer (often x100). Accept either form.
  const value = raw > 2 ? raw / 100 : raw;
  if (value < 0) return 0;
  if (value > 2) return 2;
  return value;
}

/**
 * Convert a local agent row into a `prompt-agent` author input. Agents are
 * declarative model + system-prompt runtimes, so they map directly onto the
 * prompt-agent bundle kind. Throws a clear error when the row + options cannot
 * satisfy the bundle (missing model or prompt).
 */
export function agentRowToAuthorInput(
  agent: AgentRow,
  options: AgentListingOptions = {},
): AuthorSkillInput {
  const modelId = options.modelId ?? clean(agent.modelId);
  if (!modelId) {
    throw new Error(`agent ${agent.id} (${agent.name}): a modelId is required to list as a runtime asset`);
  }
  const systemPrompt =
    options.systemPrompt ?? clean(agent.systemPrompt) ?? clean(agent.description);
  if (!systemPrompt) {
    throw new Error(`agent ${agent.id} (${agent.name}): a system prompt (or description) is required`);
  }
  const maxTokens =
    options.maxTokens ??
    (typeof agent.maxTokens === "number" && agent.maxTokens > 0 ? agent.maxTokens : undefined);
  return {
    kind: "prompt-agent",
    modelId,
    systemPrompt,
    promptTemplate: options.promptTemplate,
    maxTokens,
    temperature: options.temperature ?? normalizeTemperature(agent.temperature),
  };
}
