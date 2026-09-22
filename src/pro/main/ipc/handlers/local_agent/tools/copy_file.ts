import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import log from "electron-log";
import { ToolDefinition, AgentContext, escapeXmlAttr } from "./types";
import { safeJoin } from "@/ipc/utils/path_utils";
import { gitAdd } from "@/ipc/utils/git_utils";
import { deploySupabaseFunction } from "../../../../../../supabase_admin/supabase_management_client";
import {
  isServerFunction,
  isSharedServerModule,
} from "../../../../../../supabase_admin/supabase_utils";

const logger = log.scope("copy_file");

function getFunctionNameFromPath(input: string): string {
  return path.basename(path.extname(input) ? path.dirname(input) : input);
}

const copyFileSchema = z.object({
  from: z.string().describe("The source file path to copy from"),
  to: z.string().describe("The destination file path to copy to"),
});

export const copyFileTool: ToolDefinition<z.infer<typeof copyFileSchema>> = {
  name: "copy_file",
  description:
    "Copy a file in the codebase to a new path, leaving the original in place. Useful for duplicating a component, config, or template file as a starting point.",
  inputSchema: copyFileSchema,
  defaultConsent: "always",

  getConsentPreview: (args) => `Copy ${args.from} to ${args.to}`,

  buildXml: (args, _isComplete) => {
    if (!args.from || !args.to) return undefined;
    return `<joy-copy from="${escapeXmlAttr(args.from)}" to="${escapeXmlAttr(args.to)}"></joy-copy>`;
  },

  execute: async (args, ctx: AgentContext) => {
    const fromFullPath = safeJoin(ctx.appPath, args.from);
    const toFullPath = safeJoin(ctx.appPath, args.to);

    if (!fs.existsSync(fromFullPath)) {
      throw new Error(`Source file for copy does not exist: ${args.from}`);
    }

    // Track if this involves shared modules
    if (isSharedServerModule(args.to)) {
      ctx.isSharedModulesChanged = true;
    }

    // Ensure target directory exists
    const dirPath = path.dirname(toFullPath);
    fs.mkdirSync(dirPath, { recursive: true });

    fs.copyFileSync(fromFullPath, toFullPath);
    logger.log(`Successfully copied file: ${fromFullPath} -> ${toFullPath}`);

    // Update git for the new file
    await gitAdd({ path: ctx.appPath, filepath: args.to });

    // Deploy the copy as a Supabase function if applicable
    if (
      ctx.supabaseProjectId &&
      isServerFunction(args.to) &&
      !ctx.isSharedModulesChanged
    ) {
      try {
        await deploySupabaseFunction({
          supabaseProjectId: ctx.supabaseProjectId,
          functionName: getFunctionNameFromPath(args.to),
          appPath: ctx.appPath,
          organizationSlug: ctx.supabaseOrganizationSlug ?? null,
        });
      } catch (error) {
        return `File copied, but failed to deploy Supabase function: ${error}`;
      }
    }

    return `Successfully copied ${args.from} to ${args.to}`;
  },
};
