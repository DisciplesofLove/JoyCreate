/**
 * write_app_blueprint tool — Establish or update the app's persistent
 * blueprint (AI_RULES.md).
 *
 * AI_RULES.md is loaded into the system prompt on every future turn (via the
 * [[AI_RULES]] slot), so it is the canonical place to record the app's tech
 * stack, architectural decisions, conventions, and "always/never" rules. The
 * agent uses this at the start of a project — or when conventions change — so
 * that all subsequent work stays consistent, even across chats and sessions.
 */

import fs from "node:fs";
import { z } from "zod";
import log from "electron-log";
import { ToolDefinition, AgentContext, escapeXmlAttr } from "./types";
import { safeJoin } from "@/ipc/utils/path_utils";
import { gitAdd } from "@/ipc/utils/git_utils";

const logger = log.scope("write_app_blueprint");

const BLUEPRINT_FILE = "AI_RULES.md";

const writeAppBlueprintSchema = z.object({
  content: z
    .string()
    .min(1)
    .describe(
      "The full Markdown blueprint: tech stack (5-10 bullets), architecture, folder conventions, and clear rules about which libraries to use for what.",
    ),
  merge: z
    .boolean()
    .optional()
    .describe(
      "If true and a blueprint already exists, append the content under a divider instead of overwriting. Default false (overwrite).",
    ),
});

export const writeAppBlueprintTool: ToolDefinition<
  z.infer<typeof writeAppBlueprintSchema>
> = {
  name: "write_app_blueprint",
  description: `Create or update the app's persistent blueprint (AI_RULES.md) — the tech stack, architecture, and conventions that guide ALL future work on this app.
This file is automatically included in your context on every turn, so use it to lock in decisions like:
- The exact tech stack and versions
- Which libraries to use for what (routing, state, styling, data)
- Folder structure and naming conventions
- Hard "always" / "never" rules
Set this up at the start of a new project, and update it whenever conventions change. Prefer this over burying conventions in chat.`,
  inputSchema: writeAppBlueprintSchema,
  defaultConsent: "always",

  getConsentPreview: () => `Update app blueprint (${BLUEPRINT_FILE})`,

  buildXml: (args, isComplete) => {
    let xml = `<joy-write path="${escapeXmlAttr(BLUEPRINT_FILE)}" description="App blueprint / conventions">\n${args.content ?? ""}`;
    if (isComplete) {
      xml += "\n</joy-write>";
    }
    return xml;
  },

  execute: async (args, ctx: AgentContext) => {
    const fullPath = safeJoin(ctx.appPath, BLUEPRINT_FILE);

    let finalContent = args.content;
    if (args.merge && fs.existsSync(fullPath)) {
      const existing = fs.readFileSync(fullPath, "utf8");
      finalContent = `${existing.trimEnd()}\n\n---\n\n${args.content.trimStart()}`;
    }

    fs.writeFileSync(fullPath, finalContent);
    logger.log(`Wrote app blueprint: ${fullPath}`);

    try {
      await gitAdd({ path: ctx.appPath, filepath: BLUEPRINT_FILE });
    } catch (error) {
      logger.warn(`Could not git-add ${BLUEPRINT_FILE}: ${error}`);
    }

    return `App blueprint written to ${BLUEPRINT_FILE}. These conventions will guide all future work on this app.`;
  },
};
