/**
 * MCP Tools — skills and plugins.
 *
 * Routed through the registered `skill:*` and `plugin:*` IPC channels.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { invokeHandler, runTool, toolError } from "./invoke_handler";

export function registerSkillsTools(server: McpServer) {
  server.registerTool(
    "joycreate_skill_create",
    {
      description:
        "Create a reusable JoyCreate skill. `category` and `implementationType` are " +
        "NOT NULL in the skills table, so both are required rather than defaulted " +
        "silently to something the caller did not choose.",
      inputSchema: {
        name: z.string().describe("Skill name"),
        description: z.string().describe("What the skill does"),
        category: z
          .enum([
            "text_generation",
            "code_generation",
            "code_review",
            "summarization",
            "translation",
            "question_answering",
            "reasoning",
            "math",
            "vision",
            "function_calling",
            "web_search",
            "file_operations",
            "data_analysis",
            "creative_writing",
            "structured_output",
          ])
          .describe("Capability this skill provides"),
        implementationType: z
          .enum(["prompt", "function", "tool", "workflow"])
          .describe("How the skill is implemented"),
        implementationCode: z
          .string()
          .optional()
          .describe("Prompt text, function body, or workflow reference"),
        tags: z.array(z.string()).optional().describe("Free-form tags"),
      },
    },
    async (params) => runTool("joycreate_skill_create", () =>
      invokeHandler("skill:create", {
        name: params.name,
        description: params.description,
        category: params.category,
        type: "custom",
        implementationType: params.implementationType,
        implementationCode: params.implementationCode,
        tags: params.tags,
      })),
  );

  server.registerTool(
    "joycreate_skill_list",
    {
      description: "List skills available in this JoyCreate install.",
      inputSchema: {},
    },
    async () => runTool("joycreate_skill_list", () => invokeHandler("skill:list")),
  );

  server.registerTool(
    "joycreate_skill_publish",
    {
      description: "Publish a skill to Joy Marketplace.",
      inputSchema: {
        skillId: z.string().describe("Skill id (unused — see the error text)"),
      },
    },
    async () =>
      toolError(
        "joycreate_skill_publish is not a separate path. Export the skill with " +
          "skill:export, then call joycreate_publish_asset with its bytes and " +
          "assetType 'skill'.",
      ),
  );

  server.registerTool(
    "joycreate_plugin_list",
    {
      description: "List installed JoyCreate plugins.",
      inputSchema: {},
    },
    async () => runTool("joycreate_plugin_list", () => invokeHandler("plugin:list")),
  );

  server.registerTool(
    "joycreate_plugin_install",
    {
      description:
        "Install a plugin from the JoyCreate registry. Modifies the local install — " +
        "invoke with user approval.",
      inputSchema: {
        pluginId: z.string().describe("Plugin id in the registry"),
      },
    },
    async (params) => runTool("joycreate_plugin_install", () =>
      invokeHandler("plugin:install-from-registry", params)),
  );
}
