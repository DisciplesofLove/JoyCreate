/**
 * Telegram and Discord must get the SAME tool list as the local agent — built
 * from the real MCP registrars, not a copy that can drift.
 *
 * Separate from channel_agent_tools.test.ts because it loads every MCP tool
 * module for real; if one of those ever stops importing cleanly under test,
 * the logic tests should still run.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/joycreate-test", getName: () => "JoyCreate", getVersion: () => "0.0.0-test" },
  ipcMain: { handle: vi.fn(), on: vi.fn(), removeHandler: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] },
}));

vi.mock("@/db", () => ({ db: {} }));

import { buildChannelTools } from "@/lib/channels/channel_agent_tools";
import { getMcpAgentToolNames } from "@/pro/main/ipc/handlers/local_agent/tools/mcp_tools_adapter";

describe("the tools a chat bot gets", () => {
  const set = buildChannelTools({ channel: "telegram" });

  it("is every tool the local agent has — at least the 97 it exposes today", () => {
    expect(set.names).toEqual(getMcpAgentToolNames());
    expect(set.names.length).toBeGreaterThanOrEqual(97);
  });

  it("uses names every provider accepts", () => {
    // OpenAI and Anthropic both reject tool names outside this pattern, and a
    // single bad name fails the whole request — not just that tool.
    for (const name of set.names) {
      expect(name, name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    }
  });

  it("has no duplicate names, and none that shadow execute_joycreate_task", () => {
    expect(new Set(set.names).size).toBe(set.names.length);
    expect(set.names).not.toContain("execute_joycreate_task");
  });

  it("includes the capabilities people ask a bot for", () => {
    const joined = set.names.join(" ");
    for (const area of ["email", "publish", "document", "image", "app"]) {
      expect(joined, `no ${area} tool exposed`).toContain(area);
    }
  });

  it("flags state-changing tools, including verb-last names", () => {
    // The old heuristic only matched `verb_…` and `…_verb_…`, so noun-first
    // names like app_deploy and agent_hire ran with no consent — 6 of 97 flagged.
    for (const name of [
      "app_deploy",
      "app_write_file",
      "agent_hire",
      "agent_refund",
      "skill_publish",
      "plugin_install",
      "publish_asset",
      "create_document",
    ]) {
      expect(set.destructiveNames, `${name} should require consent`).toContain(name);
    }
  });

  it("does not flag read-only tools", () => {
    for (const name of ["app_list", "email_search", "get_agent", "marketplace_browse"]) {
      expect(set.destructiveNames, `${name} should not require consent`).not.toContain(name);
    }
  });
});
