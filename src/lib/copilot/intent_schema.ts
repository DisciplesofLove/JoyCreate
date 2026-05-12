/**
 * Copilot intent schema — what the local Ollama router emits after
 * classifying a plain-English user prompt.
 *
 * The schema is intentionally tiny: kind + (tool|args) | (taskBrief).
 * The Copilot orchestrator routes on `kind`.
 */

import { z } from "zod";

export const CopilotIntentSchema = z.object({
  kind: z.enum(["chat", "tool", "code-task"]),
  /** Required when kind === "tool". Must be in the tool registry allowlist. */
  tool: z.string().optional(),
  /** Arguments to pass to the tool (object). */
  args: z.record(z.unknown()).optional(),
  /** Required when kind === "code-task". Bounded brief for Claude Code. */
  taskBrief: z.string().optional(),
  /** Free-form chat reply (only when kind === "chat"). */
  reply: z.string().optional(),
  /** Local-model self-reported confidence 0..1. */
  confidence: z.number().min(0).max(1).default(0.5),
  /** Short human-facing summary of the routing decision. */
  summary: z.string().optional(),
});

export type CopilotIntent = z.infer<typeof CopilotIntentSchema>;

/**
 * The strict JSON schema we send to Ollama as a system prompt.
 * Kept in sync with CopilotIntentSchema by hand — this is the *contract*
 * the model must satisfy, expressed in natural language.
 */
export const COPILOT_ROUTER_SYSTEM_PROMPT = `You are the routing brain inside JoyCreate, a desktop AI app.

Your ONLY job is to classify the user's request and return a single JSON object.
You MUST respond with valid JSON only — no prose, no markdown, no code fences.

The JSON object MUST have these fields:
{
  "kind": "chat" | "tool" | "code-task",
  "tool": "<allowlisted tool name>"   // ONLY when kind="tool"
  "args": { ... }                      // ONLY when kind="tool"
  "taskBrief": "<3-5 sentence brief>", // ONLY when kind="code-task"
  "reply": "<short answer>",           // ONLY when kind="chat"
  "confidence": 0.0..1.0,
  "summary": "<one sentence describing what you decided>"
}

Routing rules:
- kind="chat" — the user is greeting, asking a general question, or chatting. Put your answer in "reply".
- kind="tool" — the user is asking for information that maps to one of the listed tools. Put the tool name in "tool" and any arguments in "args".
- kind="code-task" — the user is asking to fix a bug, change code, run an audit, patch a vulnerability, or anything that requires editing files. Put a clear, bounded brief in "taskBrief".

If you are uncertain (confidence < 0.7), prefer kind="chat" and explain in "reply" what you need clarified.

NEVER invent tool names. Only use tools from the allowlist below.

Available tools:
{TOOL_LIST}
`;
