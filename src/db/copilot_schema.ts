import { sql } from "drizzle-orm";
import { integer, sqliteTable, text, index } from "drizzle-orm/sqlite-core";

/**
 * Copilot — NLP-driven self-healing assistant.
 *
 * One row per user prompt. Lifecycle:
 *   pending  → local router classifies
 *   running  → either tool-call or Claude Code job in flight
 *   awaiting-approval → Claude produced a diff, waiting on human review
 *   completed | rejected | failed | cancelled
 */
export const copilotJobs = sqliteTable(
  "copilot_jobs",
  {
    id: text("id").primaryKey(), // UUID

    /** Raw English prompt from the user. */
    userPrompt: text("user_prompt").notNull(),

    /** Structured intent JSON emitted by the local router. */
    intentJson: text("intent_json", { mode: "json" }).$type<
      Record<string, unknown>
    >(),

    kind: text("kind", {
      enum: ["chat", "tool", "code-task"],
    }).notNull(),

    /** Allowlisted tool name (only set when kind="tool"). */
    toolName: text("tool_name"),

    /** Branch claude wrote to (only set when kind="code-task"). */
    branchName: text("branch_name"),

    /** Path to the diff file relative to userData. */
    diffPath: text("diff_path"),

    /** Estimated USD cost reported by the runner. */
    claudeCostUsd: text("claude_cost_usd").notNull().default("0"),

    /** Human-readable summary of what the assistant did / proposes. */
    summary: text("summary"),

    /** Final assistant response text (chat answer or job report). */
    output: text("output"),

    status: text("status", {
      enum: [
        "pending",
        "running",
        "awaiting-approval",
        "completed",
        "rejected",
        "failed",
        "cancelled",
      ],
    })
      .notNull()
      .default("pending"),

    /** DID of approver (when awaiting-approval → completed). */
    approvedBy: text("approved_by"),

    errorMessage: text("error_message"),

    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    completedAt: integer("completed_at", { mode: "timestamp" }),
  },
  (t) => ({
    idxCopStatus: index("idx_copilot_status").on(t.status),
    idxCopKind: index("idx_copilot_kind").on(t.kind),
    idxCopCreated: index("idx_copilot_created").on(t.createdAt),
  }),
);

export type CopilotJobRow = typeof copilotJobs.$inferSelect;
export type CopilotJobInsert = typeof copilotJobs.$inferInsert;
