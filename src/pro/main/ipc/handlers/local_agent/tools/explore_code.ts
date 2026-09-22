/**
 * explore_code tool — Spawn a read-only sub-agent to investigate the codebase.
 *
 * The main agent delegates an open-ended exploration question (e.g. "where is
 * auth handled?", "trace how uploads flow from UI to storage") to an isolated
 * LLM loop equipped only with read-only tools (read_file, list_files,
 * get_database_schema). The sub-agent explores autonomously and returns a
 * synthesized report — findings, relevant file paths, and how the pieces fit
 * together — without ever modifying the codebase.
 *
 * This keeps the main agent's context clean: instead of the parent reading
 * dozens of files itself, it dispatches the search and gets back a focused
 * summary.
 */

import { generateText, stepCountIs, tool, type ToolSet } from "ai";
import type { z as zType } from "zod";
import { z } from "zod";
import log from "electron-log";
import { ToolDefinition, AgentContext, escapeXmlAttr } from "./types";
import { readFileTool } from "./read_file";
import { listFilesTool } from "./list_files";
import { getDatabaseSchemaTool } from "./get_database_schema";
import { readSettings } from "@/main/settings";
import { getModelClient } from "@/ipc/utils/get_model_client";

const logger = log.scope("explore_code");

/** Read-only tools the exploration sub-agent may use. */
const EXPLORE_TOOLS: readonly ToolDefinition[] = [
  readFileTool,
  listFilesTool,
  getDatabaseSchemaTool,
];

const exploreCodeSchema = z.object({
  query: z
    .string()
    .describe(
      "The exploration question or task, e.g. 'Where is user authentication handled and how does the session token flow?'",
    ),
  focus_paths: z
    .string()
    .optional()
    .describe(
      "Optional comma-separated directories/files to focus on (hints for the sub-agent), e.g. 'src/auth, src/ipc/handlers'.",
    ),
});

const EXPLORER_SYSTEM_PROMPT = `You are a read-only codebase exploration agent.
Your job is to investigate the application's source code and answer the given question thoroughly.

Rules:
- You may ONLY read and inspect code. You cannot and must not modify anything.
- Use list_files to discover structure, read_file to inspect specific files, and get_database_schema when the question touches data models.
- Speculatively read multiple relevant files to build an accurate picture.
- Trace relationships across files (imports, calls, IPC channels, data flow).

When finished, return a concise, well-structured report containing:
1. **Answer** — a direct answer to the question.
2. **Key files** — the most relevant file paths (with a one-line note on each).
3. **How it fits together** — the flow / relationships between the pieces.
4. **Gotchas** — anything surprising, risky, or worth the main agent knowing.

Be precise and cite exact file paths. Do not invent files you did not read.`;

function wrapExploreTool(def: ToolDefinition, ctx: AgentContext) {
  return tool({
    description: def.description,
    inputSchema: def.inputSchema as zType.ZodTypeAny,
    execute: async (args: unknown) => {
      try {
        const result = await def.execute(args as never, ctx);
        return typeof result === "string" ? result : JSON.stringify(result);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(`[explore-tool] ${def.name} failed: ${msg}`);
        return `ERROR: ${msg}`;
      }
    },
  });
}

export const exploreCodeTool: ToolDefinition<
  z.infer<typeof exploreCodeSchema>
> = {
  name: "explore_code",
  description: `Delegate an open-ended codebase investigation to a read-only sub-agent.
Use this instead of reading many files yourself when you need to understand how something works
across multiple files (e.g. "how does auth flow?", "where is X configured?", "trace the upload path").
The sub-agent explores autonomously with read-only tools and returns a focused report — keeping your context clean.
It NEVER modifies code. For simple single-file lookups, use read_file directly instead.`,
  inputSchema: exploreCodeSchema,
  defaultConsent: "always",

  getConsentPreview: (args) =>
    `Explore: ${args.query?.slice(0, 80) ?? "..."}`,

  buildXml: (args, isComplete) => {
    const q = args.query ? ` query="${escapeXmlAttr(args.query.slice(0, 200))}"` : "";
    let xml = `<joy-explore${q}>`;
    if (isComplete) {
      xml += "</joy-explore>";
    }
    return xml;
  },

  execute: async (args, ctx: AgentContext) => {
    const settings = readSettings();
    const { modelClient } = await getModelClient(
      settings.selectedModel,
      settings,
    );

    const sdkTools: ToolSet = {};
    for (const def of EXPLORE_TOOLS) {
      sdkTools[def.name] = wrapExploreTool(def, ctx);
    }

    const focusHint = args.focus_paths
      ? `\n\nFocus your search on these paths first: ${args.focus_paths}`
      : "";

    const prompt = `Investigate the following question about this codebase and report back:\n\n${args.query}${focusHint}`;

    logger.info(`explore_code: "${args.query.slice(0, 100)}"`);

    try {
      const result = await generateText({
        model: modelClient.model,
        system: EXPLORER_SYSTEM_PROMPT,
        prompt,
        tools: sdkTools,
        stopWhen: stepCountIs(12),
      });

      const filesInspected = new Set<string>();
      for (const step of result.steps ?? []) {
        for (const call of step.toolCalls ?? []) {
          if (call.toolName === "read_file") {
            const p = (call.input as { path?: string } | undefined)?.path;
            if (p) filesInspected.add(p);
          }
        }
      }

      const report = result.text.trim();
      if (!report) {
        return "The exploration sub-agent returned no findings. Try a more specific query.";
      }

      const footer =
        filesInspected.size > 0
          ? `\n\n---\n_Files inspected: ${[...filesInspected].join(", ")}_`
          : "";

      return report + footer;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`explore_code failed: ${msg}`);
      return `Exploration failed: ${msg}`;
    }
  },
};
