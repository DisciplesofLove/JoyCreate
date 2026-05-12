/**
 * Copilot tool registry — curated allowlist of read-only IPC operations
 * the local Ollama router is allowed to invoke directly.
 *
 * Anything destructive, money-moving, or code-editing must go through the
 * code-task path (Claude Code SDK + human approval), NOT through tools here.
 *
 * Tools are described in plain English so the local model can pick them.
 */

import { ipcMain } from "electron";
import log from "electron-log";

const logger = log.scope("copilot:tool_registry");

export interface CopilotTool {
  name: string;
  /** Plain-English description shown to the local router. */
  description: string;
  /** Underlying IPC channel to invoke. */
  ipcChannel: string;
  /** Optional argument transformer. */
  buildArgs?: (raw: Record<string, unknown>) => unknown[];
}

export const COPILOT_TOOLS: CopilotTool[] = [
  // ---- Federation / network ---------------------------------------------
  {
    name: "list-peers",
    description: "List all known federation peers (online and offline).",
    ipcChannel: "federation:get-peers",
  },
  {
    name: "list-connected-peers",
    description: "List currently connected federation peers.",
    ipcChannel: "federation:get-connected-peers",
  },
  {
    name: "federation-stats",
    description: "Get high-level federation network statistics.",
    ipcChannel: "federation:get-stats",
  },
  {
    name: "list-listings",
    description: "List all active P2P marketplace listings.",
    ipcChannel: "federation:get-listings",
  },
  {
    name: "list-transactions",
    description: "List all P2P transactions.",
    ipcChannel: "federation:get-transactions",
  },

  // ---- Hyper / decentralized state --------------------------------------
  {
    name: "hyper-status",
    description:
      "Get the status of the hypercore peer layer (device key, swarm peers, open topics).",
    ipcChannel: "hyper:status",
  },

  // ---- Provenance & audit -----------------------------------------------
  {
    name: "list-recent-provenance",
    description:
      "List the most recent agent provenance events (signed activity feed).",
    ipcChannel: "agent-provenance:list-recent",
  },

  // ---- Whitehat MCP audit -----------------------------------------------
  {
    name: "list-mcp-audit",
    description:
      "List recent Whitehat MCP audit entries (allowed/denied tool calls from Claude Desktop).",
    ipcChannel: "whitehat:mcp:list-audit",
  },
  {
    name: "list-mcp-pending",
    description:
      "List Whitehat MCP requests awaiting human approval.",
    ipcChannel: "whitehat:mcp:list-pending",
  },
];

/**
 * Find a tool by its allowlisted name. Returns undefined if not allowed.
 */
export function findCopilotTool(name: string): CopilotTool | undefined {
  return COPILOT_TOOLS.find((t) => t.name === name);
}

/**
 * Render the tool list as text for the local router system prompt.
 */
export function renderToolListForPrompt(): string {
  return COPILOT_TOOLS.map((t) => `- ${t.name}: ${t.description}`).join("\n");
}

/**
 * Invoke a registered tool by directly calling its IPC handler.
 * We re-enter the ipcMain handler from the main process so the tool's
 * normal logic (including any guarded-handle wrapping) runs unchanged.
 */
export async function invokeCopilotTool(
  tool: CopilotTool,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  // Electron exposes the registered handler map on _invokeHandlers (private),
  // but the supported way is to import the handler module directly. To keep
  // this generic, we simulate the renderer call by reaching into ipcMain.
  // ipcMain.handle stores handlers in a private map; instead of relying on
  // private internals, we use ipcMain.eventNames + a synthetic event.
  const handlers = (ipcMain as unknown as {
    _invokeHandlers?: Map<string, (event: unknown, ...args: unknown[]) => unknown>;
  })._invokeHandlers;

  if (!handlers || !handlers.has(tool.ipcChannel)) {
    throw new Error(`Copilot tool "${tool.name}" has no registered IPC handler at "${tool.ipcChannel}".`);
  }

  const handler = handlers.get(tool.ipcChannel)!;
  const positional = tool.buildArgs ? tool.buildArgs(args) : [args];

  // Synthetic event — handlers that don't need event.sender (the read-only
  // tools we allowlist) are safe with a stub.
  const syntheticEvent = {
    sender: null,
    senderFrame: null,
    processId: process.pid,
    frameId: 0,
  };

  try {
    return await handler(syntheticEvent, ...positional);
  } catch (err) {
    logger.warn(`Tool "${tool.name}" failed:`, err);
    throw err;
  }
}
