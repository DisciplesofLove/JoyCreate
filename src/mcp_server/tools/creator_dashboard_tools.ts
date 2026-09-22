/**
 * MCP Tools — creator dashboard.
 *
 * Routed through the registered `creator:*` IPC channels.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { invokeHandler, runTool, toolError } from "./invoke_handler";

export function registerCreatorDashboardTools(server: McpServer) {
  server.registerTool(
    "joycreate_creator_stats",
    {
      description:
        "Creator overview: published assets, sales, views and reputation at a glance.",
      inputSchema: {},
    },
    async () => runTool("joycreate_creator_stats", () =>
      invokeHandler("creator:get-overview")),
  );

  server.registerTool(
    "joycreate_creator_portfolio",
    {
      description: "Every asset this creator has published, with status and pricing.",
      inputSchema: {
        limit: z.number().optional().describe("Max results"),
      },
    },
    async (params) => runTool("joycreate_creator_portfolio", () =>
      invokeHandler("creator:get-all-assets", params)),
  );

  server.registerTool(
    "joycreate_creator_earnings",
    {
      description: "Earnings broken down by asset, period and revenue source.",
      inputSchema: {
        period: z.string().optional().describe("Period filter, e.g. '30d'"),
      },
    },
    async (params) => runTool("joycreate_creator_earnings", () =>
      invokeHandler("creator:get-earnings-breakdown", params)),
  );

  server.registerTool(
    "joycreate_analytics",
    {
      description: "Creator analytics: views, conversions and trends over time.",
      inputSchema: {
        period: z.string().optional().describe("Period filter, e.g. '30d'"),
      },
    },
    async (params) => runTool("joycreate_analytics", () =>
      invokeHandler("creator:get-analytics", params)),
  );
}
