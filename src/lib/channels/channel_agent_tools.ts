/**
 * The JoyCreate tools a Telegram or Discord conversation can call directly.
 *
 * Until now a chat bot's model got exactly one tool, `execute_joycreate_task`,
 * which hands a sentence to the autonomous planner and hopes the plan picks the
 * right action. The local agent, meanwhile, has the full MCP tool surface — 97
 * typed tools with real schemas. Same app, same handlers, two very different
 * levels of capability depending on whether you typed in the window or in chat.
 *
 * This builds the same tool list the local agent gets (`getMcpAgentTools`) as
 * ai-sdk tools, so the chat model can call `create_document`, `send_email`,
 * `publish_asset`… directly, with validated arguments. `execute_joycreate_task`
 * stays alongside them as the catch-all for requests no single tool covers.
 *
 * Shared by both bots: their handlers were copies of each other, and a second
 * copy of this is how the two would drift.
 */

import { existsSync } from "node:fs";
import log from "electron-log";
import { tool, type ToolSet } from "ai";

import { getMcpAgentTools } from "@/pro/main/ipc/handlers/local_agent/tools/mcp_tools_adapter";
import type { AgentContext } from "@/pro/main/ipc/handlers/local_agent/tools/types";

const logger = log.scope("channel-agent-tools");

/**
 * A tool result goes back into the model's context on every later step.
 * Some tools return whole documents or listings; unbounded, a couple of calls
 * would crowd out the conversation.
 */
export const MAX_TOOL_OUTPUT_CHARS = 6000;

/** Absolute paths to generated media, Windows or POSIX, inside tool output. */
const MEDIA_PATH =
  /(?:[A-Za-z]:[\\/]|\/)[^\s"'<>|*?]+?\.(?:png|jpe?g|webp|gif|mp4|webm|mov)\b/gi;

export interface ChannelToolHooks {
  channel: "telegram" | "discord";
  /** Called when a tool starts — the handler shows "typing…". */
  onToolStart?: (toolName: string) => void;
  /**
   * Called once per generated image/video file found in a tool's output, so the
   * picture arrives in the chat instead of a file path the user cannot open.
   */
  onMediaFile?: (filePath: string, toolName: string) => Promise<void>;
  /** Existence check for media paths. Defaults to `fs.existsSync`. */
  fileExists?: (filePath: string) => boolean;
}

export interface ChannelToolSet {
  tools: ToolSet;
  /** Every tool name exposed, in order. */
  names: string[];
  /** Tools that change state (create, send, publish, spend…). */
  destructiveNames: string[];
  /** How many tool calls have run in this conversation turn. */
  callCount: () => number;
  /** A short summary of the most recent tool result, for fallback replies. */
  lastSummary: () => string;
}

export function truncateToolOutput(text: string, max = MAX_TOOL_OUTPUT_CHARS): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n[…output truncated: ${text.length - max} more characters]`;
}

/** Media file paths mentioned in a tool's output, deduplicated, in order. */
export function extractMediaPaths(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(MEDIA_PATH)) {
    // JSON output escapes backslashes; undo that so the path exists on disk.
    found.add(match[0].replace(/\\\\/g, "\\"));
  }
  return [...found];
}

let loggedCount = false;

/**
 * Build the tool set for one conversation turn.
 *
 * Call per turn, not once per process: the call counter and media dedupe are
 * per-turn state. The underlying tool definitions are memoised by the adapter,
 * so this is cheap.
 */
export function buildChannelTools(hooks: ChannelToolHooks): ChannelToolSet {
  const definitions = getMcpAgentTools();
  const tools: ToolSet = {};
  const destructiveNames: string[] = [];
  const mediaSent = new Set<string>();
  const fileExists = hooks.fileExists ?? existsSync;
  let calls = 0;
  let last = "";

  for (const def of definitions) {
    const destructive = def.defaultConsent === "ask";
    if (destructive) destructiveNames.push(def.name);

    tools[def.name] = tool({
      // In the app, a state-changing tool asks the user before it runs. A chat
      // has no consent dialog, so the model is told plainly instead.
      description: destructive
        ? `${def.description}\n\nThis changes things in JoyCreate. Only call it when the user has asked for this action.`
        : def.description,
      inputSchema: def.inputSchema,
      execute: async (args: unknown) => {
        calls++;
        hooks.onToolStart?.(def.name);

        // MCP tools do not read the agent context; they reach the app through
        // IPC. Errors propagate — ai-sdk reports them to the model as a failed
        // tool call, which is the honest outcome.
        const output = await def.execute(args, {} as AgentContext);

        for (const filePath of extractMediaPaths(output)) {
          if (mediaSent.has(filePath) || !fileExists(filePath)) continue;
          mediaSent.add(filePath);
          try {
            await hooks.onMediaFile?.(filePath, def.name);
          } catch (err) {
            logger.warn(`${hooks.channel}: could not send ${filePath} from ${def.name}:`, err);
          }
        }

        last = `${def.name}: ${truncateToolOutput(output, 400)}`;
        return truncateToolOutput(output);
      },
    });
  }

  if (!loggedCount) {
    loggedCount = true;
    logger.info(
      `Chat bots expose ${definitions.length} JoyCreate tools (${destructiveNames.length} change state) plus execute_joycreate_task`,
    );
  }

  return {
    tools,
    names: definitions.map((d) => d.name),
    destructiveNames,
    callCount: () => calls,
    lastSummary: () => last,
  };
}
