/**
 * Fine-tuning job records.
 *
 * A LoRA or QLoRA run takes hours. Both training implementations kept their
 * jobs in a module-level `Map`, so closing the app did not fail a run — it
 * erased it, leaving a half-written adapter directory with nothing pointing at
 * it and no way to tell what epoch it reached.
 *
 * The columns mirror `TrainingJobInfo` (`src/ipc/ipc_types.ts`), which is what
 * the handlers already return, so persisting a job is a write-through rather
 * than a second shape to keep in sync.
 */

import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const trainingJobs = sqliteTable("training_jobs", {
  id: text("id").primaryKey(), // UUID v4

  name: text("name").notNull(),
  description: text("description"),

  // What is being trained, and how
  baseModelId: text("base_model_id").notNull(),
  method: text("method", { enum: ["lora", "qlora", "full"] }).notNull(),

  status: text("status", {
    enum: [
      "queued",
      "running",
      "completed",
      "failed",
      "cancelled",
      // Set at boot for a run whose process did not survive a restart. Distinct
      // from `failed`: nothing went wrong with the training itself.
      "interrupted",
    ],
  })
    .notNull()
    .default("queued"),

  // Progress
  progress: integer("progress").notNull().default(0), // 0-100
  currentEpoch: integer("current_epoch").default(0),
  totalEpochs: integer("total_epochs"),
  currentStep: integer("current_step"),
  totalSteps: integer("total_steps"),
  currentLoss: integer("current_loss"), // loss × 10000, kept integral
  gpuMemoryUsedMb: integer("gpu_memory_used_mb"),

  // Inputs and outputs
  datasetId: text("dataset_id"),
  datasetPath: text("dataset_path"),
  outputPath: text("output_path").notNull(),
  hyperparametersJson: text("hyperparameters_json", { mode: "json" }).$type<
    Record<string, unknown> | null
  >(),

  /**
   * PID of the python child process while it runs.
   *
   * Recorded so a future run can tell "this process is gone" from "this row was
   * never cleaned up", and cleared on every terminal transition.
   */
  pid: integer("pid"),

  /** The `os_activities` row mirroring this run, for the shell and tray. */
  activityId: text("activity_id"),

  /** Set once the finished adapter is registered in the model registry. */
  registryEntryId: text("registry_entry_id"),

  error: text("error"),

  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  startedAt: integer("started_at", { mode: "timestamp" }),
  completedAt: integer("completed_at", { mode: "timestamp" }),
});

export type TrainingJobRow = typeof trainingJobs.$inferSelect;
export type NewTrainingJob = typeof trainingJobs.$inferInsert;
