/**
 * LRA glue — convert a local `skills` row into the on-chain `AuthorSkillInput`
 * consumed by LR11 (`publishSkillToAgent`).
 *
 * The local skill catalogue (`skills` table) and the on-chain Licensed Runtime
 * Asset pipeline (ERC-8004 agent card `skillCID` + A2A listings) historically
 * lived apart. This adapter is the missing converter: it maps a skill's
 * `implementationType` to the matching runtime bundle kind so any local skill
 * can be authored, pinned, and attached to an agent's on-chain identity.
 *
 *   prompt   → prompt-agent  (systemPrompt + optional template)
 *   tool     → tool-agent    (allow-listed MCP tools)
 *   function → code-agent    (JS executed in the LR10 sandbox)
 *   workflow → (not yet supported — needs a workflow runtime)
 *
 * Pure + side-effect free so it is trivially unit-testable.
 */

import type { skills } from "@/db/schema";
import type { AuthorSkillInput } from "@/lib/onchain/skill_authoring";

/** A row from the local `skills` table. */
export type SkillRow = typeof skills.$inferSelect;

/**
 * Caller-supplied fields the `skills` row cannot carry on its own (e.g. the
 * model a prompt/tool agent runs on, or the MCP tool allow-list).
 */
export interface SkillListingOptions {
  /** Model id for prompt-agent / tool-agent skills (required for those kinds). */
  modelId?: string;
  /** Override the system prompt; defaults to the skill's implementation/description. */
  systemPrompt?: string;
  /** Optional user-prompt template; `{{input}}` is substituted at runtime. */
  promptTemplate?: string;
  maxTokens?: number;
  temperature?: number;
  /** Fully-qualified MCP tool names (`mcp__<server>__<tool>`) for tool-agent skills. */
  tools?: string[];
  maxSteps?: number;
  /** Modules a code-agent skill may `require(...)` (deny-all unless listed). */
  allowedModules?: string[];
  timeoutMs?: number;
  maxMemoryMb?: number;
}

/** Trimmed string or undefined (never an empty string). */
function clean(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Convert a local skill row into the on-chain author input. Throws a clear
 * error when the row + options cannot satisfy the target bundle kind, so a
 * caller never pins a skill the runtime would reject.
 */
export function skillRowToAuthorInput(
  skill: SkillRow,
  options: SkillListingOptions = {},
): AuthorSkillInput {
  const code = clean(skill.implementationCode);
  const systemPrompt = options.systemPrompt ?? code ?? clean(skill.description);

  switch (skill.implementationType) {
    case "prompt": {
      if (!options.modelId) {
        throw new Error(`skill ${skill.id} (${skill.name}): a prompt skill needs a modelId to be listed`);
      }
      if (!systemPrompt) {
        throw new Error(`skill ${skill.id} (${skill.name}): prompt skill has no prompt text or description`);
      }
      return {
        kind: "prompt-agent",
        modelId: options.modelId,
        systemPrompt,
        promptTemplate: options.promptTemplate,
        maxTokens: options.maxTokens,
        temperature: options.temperature,
      };
    }
    case "tool": {
      if (!options.modelId) {
        throw new Error(`skill ${skill.id} (${skill.name}): a tool skill needs a modelId to be listed`);
      }
      const tools = options.tools ?? [];
      if (tools.length === 0) {
        throw new Error(
          `skill ${skill.id} (${skill.name}): a tool skill needs a non-empty MCP tool allow-list`,
        );
      }
      if (!systemPrompt) {
        throw new Error(`skill ${skill.id} (${skill.name}): tool skill has no prompt text or description`);
      }
      return {
        kind: "tool-agent",
        modelId: options.modelId,
        systemPrompt,
        tools,
        maxSteps: options.maxSteps,
        promptTemplate: options.promptTemplate,
        maxTokens: options.maxTokens,
        temperature: options.temperature,
      };
    }
    case "function": {
      if (!code) {
        throw new Error(`skill ${skill.id} (${skill.name}): a function skill needs implementation code to be listed`);
      }
      return {
        kind: "code-agent",
        code,
        allowedModules: options.allowedModules,
        timeoutMs: options.timeoutMs,
        maxMemoryMb: options.maxMemoryMb,
      };
    }
    case "workflow":
      throw new Error(
        `skill ${skill.id} (${skill.name}): workflow skills cannot be listed as a Licensed Runtime Asset yet`,
      );
    default: {
      const exhaustive: never = skill.implementationType;
      throw new Error(`skill ${skill.id} (${skill.name}): unknown implementation type ${String(exhaustive)}`);
    }
  }
}
