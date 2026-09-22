/**
 * MCP Tools — compute network and routing.
 *
 * Routed through the registered `compute-network:*` and `smart-router:*` IPC
 * channels.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { invokeHandler, runTool, toolError } from "./invoke_handler";

export function registerComputeTools(server: McpServer) {
  server.registerTool(
    "joycreate_compute_status",
    {
      description:
        "Status of the JoyCreate compute network: node availability, peers and capacity.",
      inputSchema: {},
    },
    async () => runTool("joycreate_compute_status", () =>
      invokeHandler("compute-network:get-status")),
  );

  server.registerTool(
    "joycreate_compute_submit_task",
    {
      description:
        "Submit a job to the JoyCreate compute network. Use for heavy inference, " +
        "training or batch work. Returns a job id.",
      inputSchema: {
        task_type: z
          .enum(["inference", "training", "embedding", "batch_inference"])
          .describe("Job type"),
        model: z.string().describe("Model to run"),
        payload: z.record(z.any()).describe("Job payload (prompt, datasetId, ...)"),
        priority: z.enum(["low", "normal", "high"]).optional(),
        max_cost_usd: z.number().optional().describe("Abort above this cost"),
      },
    },
    async (params) => runTool("joycreate_compute_submit_task", () =>
      invokeHandler("compute-network:create-job", params)),
  );

  server.registerTool(
    "joycreate_compute_trustless_infer",
    {
      description:
        "Run verifiable inference with a cryptographic proof of execution.",
      inputSchema: {
        model: z.string().describe("Model id"),
        prompt: z.string().describe("Prompt"),
      },
    },
    async () =>
      toolError(
        "joycreate_compute_trustless_infer has no registered IPC handler — the " +
          "trustless inference surface exposes no `trustless-inference:*` channel in " +
          "this build. Use joycreate_compute_submit_task for network compute.",
      ),
  );

  server.registerTool(
    "joycreate_compute_smart_route",
    {
      description:
        "Route a request to the best available AI provider by cost, latency and " +
        "capability. Returns the chosen provider and the result.",
      inputSchema: {
        prompt: z.string().describe("The request to route"),
        requirements: z
          .record(z.any())
          .optional()
          .describe("Constraints: maxCost, maxLatency, minQuality, ..."),
      },
    },
    async (params) => runTool("joycreate_compute_smart_route", () =>
      invokeHandler("smart-router:route", params)),
  );
}
