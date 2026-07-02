import { z } from "zod";
import { ToolDefinition, AgentContext, escapeXmlAttr } from "./types";
import { executeSupabaseSql } from "../../../../../../supabase_admin/supabase_management_client";
import { executeNeonSql } from "../../../../../../neon_admin/neon_sql";
import { writeMigrationFile } from "../../../../../../ipc/utils/file_utils";
import { readSettings } from "../../../../../../main/settings";
import { classifySqlMutation } from "../../../../../../lib/sql_mutation";

const executeSqlSchema = z.object({
  query: z.string().describe("The SQL query to execute"),
  description: z.string().optional().describe("Brief description of the query"),
});

export const executeSqlTool: ToolDefinition<z.infer<typeof executeSqlSchema>> =
  {
    name: "execute_sql",
    description: "Execute SQL on the app's database (Supabase or Neon Postgres)",
    inputSchema: executeSqlSchema,
    defaultConsent: "ask",
    isEnabled: (ctx) => !!ctx.supabaseProjectId || !!ctx.neonProjectId,

    getConsentPreview: (args) =>
      args.query.slice(0, 100) + (args.query.length > 100 ? "..." : ""),

    buildXml: (args, isComplete) => {
      if (args.query == undefined) return undefined;

      let xml = `<joy-execute-sql description="${escapeXmlAttr(args.description ?? "")}">\n${args.query}`;
      if (isComplete) {
        xml += "\n</joy-execute-sql>";
      }
      return xml;
    },

    execute: async (args, ctx: AgentContext) => {
      if (!ctx.supabaseProjectId && !ctx.neonProjectId) {
        throw new Error("No database (Supabase or Neon) is connected to this app");
      }

      // Destructive-SQL safety gate: DROP/TRUNCATE/DELETE/UPDATE/ALTER-DROP can
      // irreversibly delete or overwrite existing data, so force an explicit
      // approval for them — even if this tool is otherwise set to auto-approve.
      const mutation = classifySqlMutation(args.query);
      if (mutation.destructive) {
        const approved = await ctx.requireConsent({
          toolName: "execute_sql",
          toolDescription: mutation.summary,
          inputPreview:
            args.query.slice(0, 200) + (args.query.length > 200 ? "..." : ""),
        });
        if (!approved) {
          return `SQL execution cancelled by user (destructive statement not approved): ${mutation.summary}`;
        }
      }

      // Neon path — execute against the app's Neon project/branch.
      if (ctx.neonProjectId) {
        const rows = await executeNeonSql({
          projectId: ctx.neonProjectId,
          branchId: ctx.neonDevelopmentBranchId,
          query: args.query,
        });
        if (rows.length === 0) {
          return "Successfully executed SQL query (no rows returned)";
        }
        return `Successfully executed SQL query. Rows:\n${JSON.stringify(rows, null, 2)}`;
      }

      await executeSupabaseSql({
        supabaseProjectId: ctx.supabaseProjectId!,
        query: args.query,
        organizationSlug: ctx.supabaseOrganizationSlug ?? null,
      });

      // Write migration file if enabled
      const settings = readSettings();
      if (settings.enableSupabaseWriteSqlMigration) {
        try {
          await writeMigrationFile(ctx.appPath, args.query, args.description);
        } catch (error) {
          return `SQL executed, but failed to write migration file: ${error}`;
        }
      }

      return "Successfully executed SQL query";
    },
  };
