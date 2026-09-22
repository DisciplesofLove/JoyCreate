import { sql } from "drizzle-orm";
import { integer, sqliteTable, text, index } from "drizzle-orm/sqlite-core";

// =============================================================================
// AGENT OS — TIER 1 (OS SHELL)
//
// Three primitives:
//   1. os_commands    — the catalogue of things the OS knows how to do
//                       (registered at startup or dynamically by integrations)
//   2. os_intents     — a desktop-wide intent surface; users (or agents)
//                       fire intents, the engine matches & dispatches them
//   3. os_activities  — the "what's running" registry. Anything long-lived
//                       (chats, missions, A2A invocations, jobs, intents)
//                       writes a row here so the OS shell can show it.
//
// All free-form references (sourceRef, dispatchedTarget) are kept as text
// to avoid tight FKs across feature areas — the OS shell is meant to be a
// loose coordinator, not a foreign-key enforcer.
// =============================================================================

export type OsActivitySource =
  | "chat"
  | "mission"
  | "a2a:invocation"
  | "a2a:contract"
  | "os:intent"
  | "background"
  | "external";

export type OsActivityStatus =
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

export type OsIntentStatus =
  | "pending"
  | "matched"
  | "dispatched"
  | "completed"
  | "failed"
  | "cancelled";

export type OsCommandScope =
  | "system"
  | "agent"
  | "app"
  | "marketplace"
  | "plugin";

/**
 * OsCommand — a registered action the OS shell knows how to invoke.
 * Commands are populated at startup (built-ins) or dynamically by integrations
 * via `registerCommand` (e.g. an installed app contributing palette entries).
 */
export const osCommands = sqliteTable(
  "os_commands",
  {
    id: text("id").primaryKey(), // stable string id, e.g. "a2a.invoke"
    title: text("title").notNull(),
    description: text("description"),
    scope: text("scope", {
      enum: ["system", "agent", "app", "marketplace", "plugin"],
    })
      .notNull()
      .default("system"),
    capability: text("capability"), // optional capability tag for policy gating
    keywords: text("keywords", { mode: "json" }).$type<string[] | null>(), // searchable

    // Dispatch target — exactly one of these should be set.
    ipcChannel: text("ipc_channel"), // forwarded over IPC to a handler
    handlerKey: text("handler_key"), // resolved via in-memory registry

    requiresInput: integer("requires_input", { mode: "boolean" })
      .notNull()
      .default(false),
    inputSchemaJson: text("input_schema_json", { mode: "json" }).$type<
      Record<string, unknown> | null
    >(),

    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    icon: text("icon"),

    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => ({
    idxCommandScope: index("idx_os_command_scope").on(t.scope),
    idxCommandEnabled: index("idx_os_command_enabled").on(t.enabled),
  }),
);

/**
 * OsIntent — a fired intent ("summarise this page", "deploy v3").
 * Lifecycle: pending → matched → dispatched → completed | failed | cancelled.
 */
export const osIntents = sqliteTable(
  "os_intents",
  {
    id: text("id").primaryKey(), // UUID
    query: text("query").notNull(),
    scope: text("scope", {
      enum: ["system", "agent", "app", "marketplace", "plugin"],
    }),
    status: text("status", {
      enum: [
        "pending",
        "matched",
        "dispatched",
        "completed",
        "failed",
        "cancelled",
      ],
    })
      .notNull()
      .default("pending"),

    matchedCommandId: text("matched_command_id"),
    dispatchedTarget: text("dispatched_target"), // ipc channel or handler key actually used
    inputJson: text("input_json", { mode: "json" }).$type<
      Record<string, unknown> | null
    >(),
    resultJson: text("result_json", { mode: "json" }).$type<
      Record<string, unknown> | null
    >(),
    errorMessage: text("error_message"),

    activityId: text("activity_id"), // back-link to os_activities row, if one was opened
    requestedBy: text("requested_by"), // "user" | did | agentId — free form

    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    dispatchedAt: integer("dispatched_at", { mode: "timestamp" }),
    completedAt: integer("completed_at", { mode: "timestamp" }),
  },
  (t) => ({
    idxIntentStatus: index("idx_os_intent_status").on(t.status),
    idxIntentCreated: index("idx_os_intent_created").on(t.createdAt),
  }),
);

/**
 * One step's outcome within an activity, keyed by step id in `stepStateJson`.
 *
 * `hash` is the resume contract: if a step's recomputed hash matches what was
 * stored, the step's inputs have not changed and it can be skipped rather than
 * re-executed. `blueprint_runs` uses the same trick via `intentHash`, and it is
 * the only reason a replay does not repeat side effects.
 */
export interface ActivityStepState {
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  hash?: string;
  output?: unknown;
  error?: string;
  startedAt?: number;
  completedAt?: number;
}

/**
 * OsActivity — anything currently or recently running across the OS.
 * Other subsystems (A2A, missions, chats) emit and update rows here so the
 * shell ("what's running") has one source of truth without coupling to them.
 */
export const osActivities = sqliteTable(
  "os_activities",
  {
    id: text("id").primaryKey(), // UUID
    source: text("source", {
      enum: [
        "chat",
        "mission",
        "a2a:invocation",
        "a2a:contract",
        "os:intent",
        "background",
        "external",
      ],
    }).notNull(),
    sourceRef: text("source_ref"), // free-form id of the underlying entity
    title: text("title").notNull(),
    subtitle: text("subtitle"),

    status: text("status", {
      enum: [
        "running",
        "paused",
        "completed",
        "failed",
        "cancelled",
        // Set at boot for rows still marked `running` from a previous process.
        // No controller survives a restart, so such a row is orphaned by
        // definition — it is neither running nor yet known to have failed.
        "interrupted",
      ],
    })
      .notNull()
      .default("running"),
    progress: integer("progress").notNull().default(0), // 0–100
    errorMessage: text("error_message"),

    // ── Resume state ────────────────────────────────────────────────────
    //
    // Modelled on `blueprint_runs` (src/db/schema.ts), the one run record in
    // this codebase that can already survive a crash: it keeps a cursor, a
    // per-step state map and the original input so a resumed run can replay
    // deterministically and skip work it already did. Every other executor
    // records the outcome but not the position, so a killed run is simply lost.
    //
    // Rows written by executors that cannot resume leave these null; the boot
    // pass fails those explicitly rather than pretending to resume them.

    /** Id of the step to run next (or the one that was in flight). */
    currentStepId: text("current_step_id"),

    /**
     * Per-step record: `{ [stepId]: { status, hash?, output?, error? } }`.
     * `hash` lets a resume skip a step whose inputs are unchanged, which is
     * what stops a replay from repeating side effects.
     */
    stepStateJson: text("step_state_json", { mode: "json" }).$type<Record<
      string,
      ActivityStepState
    > | null>(),

    /** The originating request, so a resumed run can rebuild its context. */
    inputJson: text("input_json", { mode: "json" }).$type<Record<
      string,
      unknown
    > | null>(),

    /** How many times the supervisor has restarted this run. */
    attempt: integer("attempt").notNull().default(0),

    metadataJson: text("metadata_json", { mode: "json" }).$type<
      Record<string, unknown> | null
    >(),

    startedAt: integer("started_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    completedAt: integer("completed_at", { mode: "timestamp" }),
  },
  (t) => ({
    idxActivityStatus: index("idx_os_activity_status").on(t.status),
    idxActivitySource: index("idx_os_activity_source").on(t.source),
    idxActivityStarted: index("idx_os_activity_started").on(t.startedAt),
  }),
);

// ── Row types ───────────────────────────────────────────────────────────────

export type OsCommandRow = typeof osCommands.$inferSelect;
export type OsCommandInsert = typeof osCommands.$inferInsert;
export type OsIntentRow = typeof osIntents.$inferSelect;
export type OsIntentInsert = typeof osIntents.$inferInsert;
export type OsActivityRow = typeof osActivities.$inferSelect;
export type OsActivityInsert = typeof osActivities.$inferInsert;
