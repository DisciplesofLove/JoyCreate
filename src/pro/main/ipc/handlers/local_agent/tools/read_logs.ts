/**
 * read_logs tool — Read the app's live runtime output (dev server stdout/stderr).
 *
 * Unlike get_app_logs (which runs static checks like tsc/lint/build), this tool
 * returns the actual runtime logs captured from the running dev server: HMR
 * updates, server exceptions, console output, and crash traces. Use it to debug
 * why a running app is misbehaving or throwing errors at runtime.
 */

import { z } from "zod";
import log from "electron-log";
import { ToolDefinition, AgentContext, escapeXmlContent } from "./types";
import { getAppLogs } from "@/ipc/utils/app_log_buffer";

const logger = log.scope("read_logs");

const readLogsSchema = z.object({
  filter: z
    .enum(["all", "errors"])
    .optional()
    .describe(
      'Which logs to return: "all" (stdout + stderr) or "errors" (stderr only). Defaults to "all".',
    ),
  lines: z
    .number()
    .int()
    .positive()
    .max(500)
    .optional()
    .describe("Maximum number of most-recent log lines to return. Defaults to 100."),
  search: z
    .string()
    .optional()
    .describe("Optional case-insensitive substring to filter log lines by."),
});

export const readLogsTool: ToolDefinition<z.infer<typeof readLogsSchema>> = {
  name: "read_logs",
  description: `Read the app's live runtime logs from the running dev server (stdout/stderr).
Use this to debug runtime errors, crashes, or unexpected behavior in the running app.
Returns the most recent captured output — HMR updates, server errors, console logs, and stack traces.
- filter "all" (default): both stdout and stderr
- filter "errors": stderr only (fastest way to find crashes/exceptions)
- lines: cap the number of recent lines (default 100, max 500)
- search: only return lines containing a substring
Note: the app must be (or have been) running for logs to be available.`,
  inputSchema: readLogsSchema,
  defaultConsent: "always",

  getConsentPreview: (args) =>
    `Read runtime logs (${args.filter ?? "all"})`,

  buildXml: (args, isComplete) => {
    const filter = args.filter ?? "all";
    let xml = `<joy-output type="runtime-logs" filter="${filter}">`;
    if (isComplete) {
      xml += "</joy-output>";
    }
    return xml;
  },

  execute: async (args, ctx: AgentContext) => {
    const filter = args.filter ?? "all";
    const limit = args.lines ?? 100;

    if (!ctx.appId || ctx.appId < 0) {
      return "No runtime logs available: the app id is unknown in this context.";
    }

    const entries = getAppLogs(ctx.appId, {
      errorsOnly: filter === "errors",
      limit,
      filter: args.search,
    });

    logger.info(
      `read_logs for app ${ctx.appId}: ${entries.length} entries (filter=${filter})`,
    );

    if (entries.length === 0) {
      return filter === "errors"
        ? "No runtime error logs captured. The app may not be running, or it has produced no stderr output since it started."
        : "No runtime logs captured. Start or restart the app to capture output.";
    }

    const formatted = entries
      .map((e) => {
        const tag = e.type === "stderr" ? "[stderr]" : "[stdout]";
        return `${tag} ${e.message}`;
      })
      .join("\n");

    return escapeXmlContent(formatted);
  },
};
