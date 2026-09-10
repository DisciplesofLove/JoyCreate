/**
 * MCP Tools — the AI email client.
 *
 * JoyCreate registers 45 `email:*` channels covering accounts, folders,
 * messages, drafts, AI triage/compose/summarise, an autonomous orchestrator
 * with rules, and sync. None of it was reachable over MCP, so an agent could
 * not read or act on the inbox at all.
 *
 * Exposed here are the read and AI-analysis operations plus draft saving.
 * Deliberately NOT exposed: `email:send`, message deletion, and orchestrator
 * start/stop with auto-actions. Sending mail on someone's behalf and deleting
 * their messages are not calls an agent should be able to make unattended;
 * `joycreate_email_draft` writes a draft for a human to review and send.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { invokeHandler, runTool } from "./invoke_handler";

export function registerEmailTools(server: McpServer) {
  server.registerTool(
    "joycreate_email_accounts",
    {
      description:
        "List configured email accounts (Gmail, Microsoft, IMAP/SMTP). Returns the " +
        "accountIds every other email tool needs. An empty list means no mailbox is " +
        "connected yet.",
      inputSchema: {},
    },
    async () => runTool("joycreate_email_accounts", () =>
      invokeHandler("email:account:list")),
  );

  server.registerTool(
    "joycreate_email_stats",
    {
      description:
        "Mailbox counters — total, unread, starred — optionally for one account.",
      inputSchema: {
        accountId: z.string().optional().describe("Restrict to one account"),
      },
    },
    async ({ accountId }) => runTool("joycreate_email_stats", () =>
      invokeHandler("email:stats", accountId)),
  );

  server.registerTool(
    "joycreate_email_list",
    {
      description:
        "List messages in a folder. Call joycreate_email_accounts first for the " +
        "accountId.",
      inputSchema: {
        accountId: z.string().describe("Account to read"),
        folder: z.string().describe("Folder name, e.g. INBOX"),
        limit: z.number().optional().describe("Max messages (default 25)"),
        offset: z.number().optional().describe("Offset, for paging"),
      },
    },
    async ({ accountId, folder, limit, offset }) =>
      runTool("joycreate_email_list", () =>
        invokeHandler("email:messages:list", accountId, folder, {
          limit: limit ?? 25,
          offset: offset ?? 0,
        })),
  );

  server.registerTool(
    "joycreate_email_unified",
    {
      description:
        "List recent messages in one folder across every connected account.",
      inputSchema: {
        folder: z
          .string()
          .optional()
          .describe("Folder to read across accounts. Default INBOX."),
        limit: z.number().optional().describe("Max messages (default 25)"),
        offset: z.number().optional().describe("Offset, for paging"),
      },
    },
    async ({ folder, limit, offset }) =>
      runTool("joycreate_email_unified", () =>
        // Positional `folder`, then options — not a single options object.
        invokeHandler("email:messages:list-unified", folder ?? "INBOX", {
          limit: limit ?? 25,
          offset: offset ?? 0,
        })),
  );

  server.registerTool(
    "joycreate_email_search",
    {
      description: "Full-text search across stored messages.",
      inputSchema: {
        query: z.string().describe("Search terms"),
        accountId: z.string().optional().describe("Restrict to one account"),
        limit: z.number().optional().describe("Max results"),
      },
    },
    async (params) => runTool("joycreate_email_search", () =>
      invokeHandler("email:messages:search", params)),
  );

  server.registerTool(
    "joycreate_email_thread",
    {
      description: "Fetch a whole conversation thread for a message.",
      inputSchema: {
        threadId: z
          .string()
          .describe("Thread id, taken from a message's threadId field"),
      },
    },
    async ({ threadId }) => runTool("joycreate_email_thread", () =>
      invokeHandler("email:messages:thread", threadId)),
  );

  server.registerTool(
    "joycreate_email_triage",
    {
      description:
        "AI-triage one message: category, priority and suggested action. Reads only.",
      inputSchema: {
        messageId: z.number().describe("Message to triage"),
      },
    },
    async ({ messageId }) => runTool("joycreate_email_triage", () =>
      invokeHandler("email:ai:triage", messageId)),
  );

  server.registerTool(
    "joycreate_email_summarize",
    {
      description:
        "Summarise one message or a whole thread into a few lines. Pass every id in " +
        "the thread to summarise it as a unit.",
      inputSchema: {
        messageIds: z.array(z.number()).describe("Message ids to summarise together"),
      },
    },
    async ({ messageIds }) => runTool("joycreate_email_summarize", () =>
      invokeHandler("email:ai:summarize", messageIds)),
  );

  server.registerTool(
    "joycreate_email_daily_digest",
    {
      description:
        "Generate the daily digest — what arrived, what matters, what needs a reply.",
      inputSchema: {},
    },
    async () => runTool("joycreate_email_daily_digest", () =>
      invokeHandler("email:ai:daily-digest")),
  );

  server.registerTool(
    "joycreate_email_smart_replies",
    {
      description:
        "Suggest short context-aware replies to a message. Returns candidates; it " +
        "does not send anything.",
      inputSchema: {
        messageId: z.number().describe("Message to reply to"),
      },
    },
    async ({ messageId }) => runTool("joycreate_email_smart_replies", () =>
      invokeHandler("email:ai:smart-replies", messageId)),
  );

  server.registerTool(
    "joycreate_email_draft",
    {
      description:
        "Compose a reply or new message and SAVE IT AS A DRAFT for a human to review " +
        "and send. This is the write path for email — sending is deliberately not " +
        "exposed to agents.",
      inputSchema: {
        accountId: z.string().describe("Account the draft belongs to"),
        to: z.array(z.string()).optional().describe("Recipients"),
        subject: z.string().optional().describe("Subject line"),
        body: z.string().describe("Draft body"),
        replyToMessageId: z
          .number()
          .optional()
          .describe("Message this replies to, if any"),
      },
    },
    async (params) => runTool("joycreate_email_draft", () =>
      invokeHandler("email:drafts:save", params)),
  );

  server.registerTool(
    "joycreate_email_orchestrator_status",
    {
      description:
        "Whether the autonomous email orchestrator is running, and its rule set. " +
        "Read-only — starting it, stopping it and enabling auto-actions are left to " +
        "the user.",
      inputSchema: {},
    },
    async () => runTool("joycreate_email_orchestrator_status", () =>
      invokeHandler("email:orchestrator:status")),
  );
}
