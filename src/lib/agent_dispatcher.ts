/**
 * Agent Dispatcher — single in-process entry point used by Joy Assistant,
 * CNS, OpenClaw and the schedule fan-out helper to invoke agent_builder
 * agents without going through IPC.
 *
 * The real work lives in `agent_builder_system_handlers.ts`. This module
 * adds two thin conveniences on top:
 *   1. `dispatchAgent(...)` — locate an agent by id or @slug and run it
 *      with an originating `source` tag.
 *   2. `resolveMention(text)` — parse a leading `@<slug>` or `/agent <id>`
 *      out of free-form text and return the matched agent + stripped input.
 *
 * No new IPC channel — renderer surfaces keep using `agent-builder:execute`;
 * this dispatcher is only used by main-process producers.
 */

import {
  executeAgent,
  findAgentForDispatch,
  listAgentsForDispatch,
  slugifyAgentName,
  type AgentExecutionSource,
} from "@/ipc/handlers/agent_builder_system_handlers";

export interface DispatchAgentArgs {
  agentIdOrSlug: string;
  input: unknown;
  source: AgentExecutionSource;
  sessionId?: string;
  parentExecutionId?: string;
  variables?: Record<string, unknown>;
}

export interface ResolveMentionResult {
  agentId: string;
  agentSlug: string;
  agentName: string;
  remainingText: string;
}

/**
 * Detects a leading agent mention in `text` and returns the matched agent
 * plus the remaining message body. Supports two syntaxes:
 *   - `@<slug> rest of message`
 *   - `/agent <id-or-slug> rest of message`
 * Returns `null` if no mention is found or the mention does not resolve
 * to an addressable agent.
 */
export function resolveMention(text: string): ResolveMentionResult | null {
  if (!text || typeof text !== "string") return null;
  const trimmed = text.trimStart();

  // /agent <id-or-slug> ...
  const slashMatch = trimmed.match(/^\/agent\s+([A-Za-z0-9_-]+)\s*([\s\S]*)$/);
  if (slashMatch) {
    const agent = findAgentForDispatch(slashMatch[1]);
    if (!agent) return null;
    return {
      agentId: agent.id,
      agentSlug: slugifyAgentName(agent.name) || agent.id,
      agentName: agent.name,
      remainingText: slashMatch[2].trim(),
    };
  }

  // @<slug> ...
  const atMatch = trimmed.match(/^@([a-z0-9][a-z0-9-]*)\s*([\s\S]*)$/i);
  if (atMatch) {
    const agent = findAgentForDispatch(atMatch[1]);
    if (!agent) return null;
    return {
      agentId: agent.id,
      agentSlug: slugifyAgentName(agent.name) || agent.id,
      agentName: agent.name,
      remainingText: atMatch[2].trim(),
    };
  }

  return null;
}

/** Run an agent from a non-renderer surface, stamping the originating source. */
export async function dispatchAgent(args: DispatchAgentArgs) {
  return executeAgent({
    agentIdOrSlug: args.agentIdOrSlug,
    input: args.input,
    source: args.source,
    context: {
      sessionId: args.sessionId,
      parentExecutionId: args.parentExecutionId,
      variables: args.variables ?? {},
    },
  });
}

/** Lightweight metadata for mention pickers / connector catalogs. */
export function listAddressableAgents() {
  return listAgentsForDispatch();
}
