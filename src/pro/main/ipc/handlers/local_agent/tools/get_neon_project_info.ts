/**
 * get_neon_project_info tool — Read metadata about the app's connected Neon
 * Postgres project: project name/region, branches (default/protected), and
 * databases. Use this to understand the Neon backend before writing SQL or
 * configuring the app's data layer.
 */

import { z } from "zod";
import log from "electron-log";
import { ToolDefinition, AgentContext, escapeXmlContent } from "./types";
import { getNeonProjectSummary } from "@/neon_admin/neon_sql";

const logger = log.scope("get_neon_project_info");

const getNeonProjectInfoSchema = z.object({});

export const getNeonProjectInfoTool: ToolDefinition<
  z.infer<typeof getNeonProjectInfoSchema>
> = {
  name: "get_neon_project_info",
  description: `Get information about the app's connected Neon Postgres project: name, region, branches (which is default/protected), and databases.
Use this to understand the Neon backend before executing SQL or wiring up the data layer.
Only available when a Neon database is connected to the app.`,
  inputSchema: getNeonProjectInfoSchema,
  defaultConsent: "always",
  isEnabled: (ctx) => !!ctx.neonProjectId,

  getConsentPreview: () => "Read Neon project info",

  buildXml: (_args, isComplete) => {
    let xml = `<joy-output type="neon-project-info">`;
    if (isComplete) {
      xml += "</joy-output>";
    }
    return xml;
  },

  execute: async (_args, ctx: AgentContext) => {
    if (!ctx.neonProjectId) {
      throw new Error("Neon is not connected to this app");
    }

    logger.info(`Fetching Neon project info for ${ctx.neonProjectId}`);

    const summary = await getNeonProjectSummary(
      ctx.neonProjectId,
      ctx.neonDevelopmentBranchId,
    );

    const lines: string[] = [];
    lines.push(`Neon project: ${summary.name} (${summary.projectId})`);
    lines.push(`Region: ${summary.regionId}`);
    if (summary.createdAt) {
      lines.push(`Created: ${summary.createdAt}`);
    }
    lines.push("");
    lines.push("Branches:");
    for (const b of summary.branches) {
      const flags = [
        b.isDefault ? "default" : null,
        b.isProtected ? "protected" : null,
      ]
        .filter(Boolean)
        .join(", ");
      lines.push(` - ${b.name} (${b.id})${flags ? ` [${flags}]` : ""}`);
    }
    if (summary.databases.length > 0) {
      lines.push("");
      lines.push(`Databases: ${summary.databases.join(", ")}`);
    }

    return escapeXmlContent(lines.join("\n"));
  },
};
