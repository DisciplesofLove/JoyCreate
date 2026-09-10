/**
 * MCP Tools — agent builder and swarms.
 *
 * Routed through the registered `agent:*` and `agent-swarm:*` IPC channels.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { invokeHandler, runTool, toolError } from "./invoke_handler";

export function registerAgentBuilderTools(server: McpServer) {
  server.registerTool(
    "joycreate_agent_create",
    {
      description: "Create an agent in JoyCreate.",
      inputSchema: {
        name: z.string().describe("Agent name"),
        systemPrompt: z.string().optional().describe("System prompt"),
        model: z.string().optional().describe("Model the agent runs on"),
        tools: z.array(z.string()).optional().describe("Tool names to grant"),
        type: z.string().optional().describe("Agent type / template"),
      },
    },
    async (params) => runTool("joycreate_agent_create", () =>
      invokeHandler("agent:create", params)),
  );

  server.registerTool(
    "joycreate_agent_deploy",
    {
      description:
        "Deploy an agent so it can run. Changes local state — invoke with user approval.",
      inputSchema: {
        agentId: z.string().describe("Agent id to deploy"),
        target: z.string().optional().describe("Deployment target"),
      },
    },
    async (params) => runTool("joycreate_agent_deploy", () =>
      invokeHandler("agent:deploy", params)),
  );

  server.registerTool(
    "joycreate_agent_swarm",
    {
      description:
        "Create a multi-agent swarm to work a task collectively. Returns the swarm id.",
      inputSchema: {
        name: z.string().describe("Swarm name"),
        objective: z.string().optional().describe("What the swarm should achieve"),
        agentIds: z.array(z.string()).optional().describe("Agents to include"),
      },
    },
    async (params) => runTool("joycreate_agent_swarm", () =>
      invokeHandler("agent-swarm:create-swarm", params)),
  );

  server.registerTool(
    "joycreate_agent_stack",
    {
      description: "Compose a layered agent stack.",
      inputSchema: {
        name: z.string().describe("Stack name (unused — see the error text)"),
      },
    },
    async () =>
      toolError(
        "joycreate_agent_stack has no registered IPC handler — this build exposes no " +
          "`agent-stack:*` channel. Use joycreate_agent_swarm to orchestrate several " +
          "agents together.",
      ),
  );
}
