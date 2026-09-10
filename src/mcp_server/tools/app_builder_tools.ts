/**
 * MCP Tools — app / site builder.
 *
 * The builder's IPC channels carry no namespace prefix (`create-app`,
 * `run-app`, `edit-app-file`, …), which is why an earlier pass concluded it had
 * no headless surface and stubbed these tools out with "no registered IPC
 * handler". That was wrong: 75 colon-free channels back the builder, and
 * `create-app` is one of them.
 *
 * Exposed: create, list, inspect, read/write source files, templates, and
 * run/stop. Not exposed: delete-app and reset-all — destroying a user's project
 * is not an unattended call.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { invokeHandler, runTool } from "./invoke_handler";

export function registerAppBuilderTools(server: McpServer) {
  server.registerTool(
    "joycreate_app_list",
    {
      description: "List apps and sites built in JoyCreate.",
      inputSchema: {},
    },
    async () => runTool("joycreate_app_list", () => invokeHandler("list-apps")),
  );

  server.registerTool(
    "joycreate_app_get",
    {
      description:
        "Full detail for one app: paths, chat history ids, and current state.",
      inputSchema: {
        appId: z.number().describe("App id"),
      },
    },
    async ({ appId }) => runTool("joycreate_app_get", () =>
      invokeHandler("get-app", appId)),
  );

  server.registerTool(
    "joycreate_app_create",
    {
      description:
        "Scaffold a new app or site. Creates the project directory and an initial " +
        "chat, and returns both the app and its chatId — the chat is where the " +
        "AI-builds-the-code conversation happens.",
      inputSchema: {
        name: z
          .string()
          .describe("App name. Also the directory name, so keep it path-safe."),
        assetType: z
          .string()
          .optional()
          .describe("Optional asset type hint, e.g. 'site' or 'app'."),
      },
    },
    async (params) => runTool("joycreate_app_create", () =>
      invokeHandler("create-app", params)),
  );

  server.registerTool(
    "joycreate_app_templates",
    {
      description: "List the scaffolding templates a new app can start from.",
      inputSchema: {},
    },
    async () => runTool("joycreate_app_templates", () =>
      invokeHandler("get-templates")),
  );

  server.registerTool(
    "joycreate_app_read_file",
    {
      description: "Read one source file from an app.",
      inputSchema: {
        appId: z.number().describe("App id"),
        filePath: z.string().describe("Path relative to the app root"),
      },
    },
    async ({ appId, filePath }) => runTool("joycreate_app_read_file", () =>
      invokeHandler("read-app-file", { appId, filePath })),
  );

  server.registerTool(
    "joycreate_app_write_file",
    {
      description:
        "Write one source file in an app. Overwrites the file — read it first if you " +
        "intend a partial change.",
      inputSchema: {
        appId: z.number().describe("App id"),
        filePath: z.string().describe("Path relative to the app root"),
        content: z.string().describe("Full new file contents"),
      },
    },
    async ({ appId, filePath, content }) =>
      runTool("joycreate_app_write_file", () =>
        invokeHandler("edit-app-file", { appId, filePath, content })),
  );

  server.registerTool(
    "joycreate_app_run",
    {
      description:
        "Start an app's dev server. Returns once the process is spawned; use " +
        "joycreate_app_logs to watch it come up.",
      inputSchema: {
        appId: z.number().describe("App id to run"),
      },
    },
    async ({ appId }) => runTool("joycreate_app_run", () =>
      invokeHandler("run-app", { appId })),
  );

  server.registerTool(
    "joycreate_app_stop",
    {
      description: "Stop an app's running dev server.",
      inputSchema: {
        appId: z.number().describe("App id to stop"),
      },
    },
    async ({ appId }) => runTool("joycreate_app_stop", () =>
      invokeHandler("stop-app", { appId })),
  );

  server.registerTool(
    "joycreate_app_logs",
    {
      description: "Recent build and runtime output for an app's chat session.",
      inputSchema: {
        chatId: z.number().describe("Chat id, from joycreate_app_get"),
      },
    },
    async ({ chatId }) => runTool("joycreate_app_logs", () =>
      invokeHandler("get-chat-logs", chatId)),
  );

  server.registerTool(
    "joycreate_app_deploy",
    {
      description:
        "Deploy an app to a decentralized host. Spends resources — invoke with user " +
        "approval.",
      inputSchema: {
        appId: z.number().describe("App id to deploy"),
        platform: z.string().optional().describe("Target platform"),
      },
    },
    async (params) => runTool("joycreate_app_deploy", () =>
      invokeHandler("decentralized:deploy", params)),
  );

  server.registerTool(
    "joycreate_app_deployments",
    {
      description: "Deployments recorded for an app, or all of them.",
      inputSchema: {
        appId: z.number().optional().describe("Restrict to one app"),
      },
    },
    async ({ appId }) => runTool("joycreate_app_deployments", () =>
      invokeHandler("decentralized:get-deployments", appId)),
  );
}
