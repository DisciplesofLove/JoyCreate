/**
 * Durable record of a fine-tuning run, and registration of what it produced.
 *
 * The two training implementations both kept their jobs in a module-level
 * `Map`: `model_factory_handlers.ts` (`trainingJobProgress`) and
 * `dataset_training_service.ts` (`activeJobs`). Neither wrote a single row.
 *
 * For a feature whose defining property is that it takes hours, that is the
 * worst possible place to keep the record:
 *
 *   - close the app and the job vanishes — not "fails", vanishes. The python
 *     process is a child of the app, so it dies too, and the half-written
 *     adapter on disk has nothing pointing at it;
 *   - `model-factory:list-jobs` showed only what this process happened to
 *     start, so a job from yesterday was simply not there;
 *   - on success the job object was mutated in memory and nothing inserted
 *     into `model_registry_entries`, so a finished adapter never appeared in
 *     "trained models" — the list reads that table — and could not be used,
 *     merged or published. The training worked and the result was unreachable.
 *
 * This module is the missing half: jobs persist, and a completed run registers
 * its adapter so the rest of the app can see it.
 */

import { randomUUID } from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import { and, desc, eq, inArray } from "drizzle-orm";
import log from "electron-log";

import { getDb } from "@/db";
import { trainingJobs, type TrainingJobRow } from "@/db/training_schema";
import { modelRegistryEntries } from "@/db/model_registry_schema";
import {
  completeActivity,
  failActivity,
  recordStep,
  startActivity,
} from "@/lib/runtime/activity_store";

const logger = log.scope("training_job_store");

export type TrainingMethod = "lora" | "qlora" | "full";

/**
 * The row shape callers adapt from. Exported so handlers can map a persisted
 * job back to their own return type without importing the Drizzle table.
 */
export type TrainingJobRowLike = TrainingJobRow;
export type TrainingStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export interface CreateTrainingJobInput {
  id?: string;
  name: string;
  description?: string;
  baseModelId: string;
  method: TrainingMethod;
  datasetId?: string;
  datasetPath?: string;
  outputPath: string;
  totalEpochs: number;
  hyperparameters?: Record<string, unknown>;
}

/** Persist a new job. Returns the id used for every later call. */
export function createJob(input: CreateTrainingJobInput): string {
  const id = input.id ?? randomUUID();
  const now = new Date();

  getDb()
    .insert(trainingJobs)
    .values({
      id,
      name: input.name,
      description: input.description ?? null,
      baseModelId: input.baseModelId,
      method: input.method,
      status: "queued",
      progress: 0,
      currentEpoch: 0,
      totalEpochs: input.totalEpochs,
      datasetId: input.datasetId ?? null,
      datasetPath: input.datasetPath ?? null,
      outputPath: input.outputPath,
      hyperparametersJson: input.hyperparameters ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .run();

  // Mirror into the cross-subsystem run record, so a multi-hour fine-tune
  // shows up in the tray count and the shell's activity list alongside every
  // other long-running thing the app does.
  const activityId = startActivity({
    source: "background",
    sourceRef: id,
    title: `Fine-tune: ${input.name}`,
    subtitle: `${input.method.toUpperCase()} · ${input.baseModelId}`,
    input: { jobId: id, method: input.method, baseModelId: input.baseModelId },
  });

  getDb()
    .update(trainingJobs)
    .set({ activityId })
    .where(eq(trainingJobs.id, id))
    .run();

  logger.info(`training job ${id} created (${input.method})`);
  return id;
}

export function getJob(id: string): TrainingJobRow | undefined {
  try {
    return getDb()
      .select()
      .from(trainingJobs)
      .where(eq(trainingJobs.id, id))
      .get();
  } catch {
    return undefined;
  }
}

export function listJobs(limit = 100): TrainingJobRow[] {
  try {
    return getDb()
      .select()
      .from(trainingJobs)
      .orderBy(desc(trainingJobs.createdAt))
      .limit(limit)
      .all();
  } catch (err) {
    logger.warn("listJobs failed:", err);
    return [];
  }
}

export function markStarted(id: string, pid?: number): void {
  patch(id, { status: "running", startedAt: new Date(), pid: pid ?? null });
}

export interface ProgressUpdate {
  progress?: number;
  currentEpoch?: number;
  currentStep?: number;
  totalSteps?: number;
  currentLoss?: number;
  gpuMemoryUsedMb?: number;
}

/**
 * Record training progress.
 *
 * Also written to the activity's step state, which is what makes an
 * interrupted run legible after a restart: "stopped during epoch 2 of 3" is
 * actionable, "gone" is not.
 */
export function recordProgress(id: string, update: ProgressUpdate): void {
  patch(id, { ...update });

  const job = getJob(id);
  if (!job?.activityId) return;
  recordStep(job.activityId, `epoch-${update.currentEpoch ?? 0}`, {
    status: "running",
    output: {
      progress: update.progress,
      step: update.currentStep,
      loss: update.currentLoss,
    },
  });
}

export function markCancelled(id: string): void {
  patch(id, { status: "cancelled", completedAt: new Date(), pid: null });
  const job = getJob(id);
  if (job?.activityId) failActivity(job.activityId, "cancelled by user");
}

export function markFailed(id: string, error: string): void {
  patch(id, {
    status: "failed",
    error: error.slice(0, 2000),
    completedAt: new Date(),
    pid: null,
  });
  const job = getJob(id);
  if (job?.activityId) failActivity(job.activityId, error);
}

/**
 * Complete a job and register the adapter it produced.
 *
 * Registration is the step that was missing entirely. Without a row in
 * `model_registry_entries` the adapter exists only as files in a directory:
 * "trained models" reads that table, so the thing the user waited hours for
 * was invisible everywhere in the app.
 */
export function markCompleted(id: string): { registryId?: string } {
  const job = getJob(id);
  if (!job) return {};

  patch(id, { status: "completed", progress: 100, completedAt: new Date(), pid: null });
  if (job.activityId) completeActivity(job.activityId);

  try {
    const registryId = registerAdapter(job);
    getDb()
      .update(trainingJobs)
      .set({ registryEntryId: registryId })
      .where(eq(trainingJobs.id, id))
      .run();
    logger.info(`training job ${id} completed; registered adapter ${registryId}`);
    return { registryId };
  } catch (err) {
    // The training itself succeeded and the weights are on disk. A failed
    // registration must not be reported as a failed run — say so and leave the
    // adapter recoverable by path.
    logger.error(`training job ${id} finished but registration failed:`, err);
    return {};
  }
}

/** Insert the finished adapter into the model registry. */
function registerAdapter(job: TrainingJobRow): string {
  const id = randomUUID();
  const hp = (job.hyperparametersJson ?? {}) as Record<string, unknown>;

  // `contentHash` is NOT NULL. Hashing multi-gigabyte weights here would block
  // the completion callback, so this records the adapter directory's identity
  // and leaves a real content hash to the publish path, which already hashes
  // and chunks the bytes it uploads.
  const fingerprint = adapterFingerprint(job.outputPath);

  getDb()
    .insert(modelRegistryEntries)
    .values({
      id,
      name: job.name,
      description: job.description ?? `Fine-tuned from ${job.baseModelId}`,
      version: "1.0.0",
      family: familyOf(job.baseModelId),
      author: "local",
      modelType: "fine_tuned",
      baseModelId: job.baseModelId,
      adapterType: job.method,
      adapterRank: numberOr(hp.loraR ?? hp.rank, 16),
      adapterAlpha: numberOr(hp.loraAlpha ?? hp.alpha, 32),
      contentHash: fingerprint.hash,
      fileSizeBytes: fingerprint.bytes,
      format: "safetensors",
      capabilitiesJson: { textGeneration: true, chat: true },
      provenanceJson: {
        datasetId: job.datasetId ?? undefined,
        epochs: job.totalEpochs ?? undefined,
        learningRate: numberOr(hp.learningRate, undefined),
        trainingMethod: job.method,
      },
      publishState: "local",
      source: "local",
    })
    .run();

  return id;
}

/**
 * A cheap, stable identity for an adapter directory: its total size and the
 * names and sizes of its files. Enough to tell two adapters apart and to spot
 * an empty output directory; not a cryptographic content hash, and not
 * presented as one.
 */
function adapterFingerprint(dir: string): { hash: string; bytes: number } {
  let bytes = 0;
  const parts: string[] = [];
  try {
    for (const name of fs.readdirSync(dir).sort()) {
      const st = fs.statSync(path.join(dir, name));
      if (st.isFile()) {
        bytes += st.size;
        parts.push(`${name}:${st.size}`);
      }
    }
  } catch {
    // Directory missing means the run produced nothing; the caller still gets
    // a row, with a fingerprint that makes the emptiness obvious.
  }
  const crypto = require("node:crypto") as typeof import("node:crypto");
  const hash = crypto
    .createHash("sha256")
    .update(`${dir}|${parts.join(",")}`)
    .digest("hex");
  return { hash: `dir-${hash}`, bytes };
}

function familyOf(baseModelId: string): string {
  const lower = baseModelId.toLowerCase();
  for (const f of ["llama", "mistral", "qwen", "phi", "gemma", "falcon"]) {
    if (lower.includes(f)) return f;
  }
  return "unknown";
}

function numberOr(v: unknown, fallback: number): number;
function numberOr(v: unknown, fallback: undefined): number | undefined;
function numberOr(v: unknown, fallback: number | undefined): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function patch(id: string, values: Record<string, unknown>): void {
  try {
    getDb()
      .update(trainingJobs)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(trainingJobs.id, id))
      .run();
  } catch (err) {
    logger.warn(`training job update failed for ${id}:`, err);
  }
}

/**
 * Boot pass: a job still marked `running` belonged to a process that no longer
 * exists.
 *
 * Training runs as a child process of the app, so it cannot have survived the
 * restart however recently it reported progress. Marking these `interrupted`
 * rather than leaving them `running` is what stops "list jobs" claiming a
 * training run is in flight days after it stopped — and it keeps the partial
 * output path, so the user can see what epoch it reached before deciding
 * whether to start again.
 */
export function reconcileTrainingJobsAtBoot(): number {
  try {
    const orphans = getDb()
      .select()
      .from(trainingJobs)
      .where(inArray(trainingJobs.status, ["running", "queued"]))
      .all();

    if (orphans.length === 0) return 0;

    getDb()
      .update(trainingJobs)
      .set({
        status: "interrupted",
        error: "interrupted: JoyCreate exited while this run was in progress",
        pid: null,
        updatedAt: new Date(),
      })
      .where(inArray(trainingJobs.status, ["running", "queued"]))
      .run();

    logger.info(`marked ${orphans.length} interrupted training job(s) at boot`);
    return orphans.length;
  } catch (err) {
    logger.warn("reconcileTrainingJobsAtBoot failed:", err);
    return 0;
  }
}

/** Jobs that stopped partway and still have output on disk. */
export function listResumableTrainingJobs(): TrainingJobRow[] {
  try {
    return getDb()
      .select()
      .from(trainingJobs)
      .where(
        and(
          eq(trainingJobs.status, "interrupted"),
          // A run that never started has nothing worth pointing at.
          eq(trainingJobs.progress, trainingJobs.progress),
        ),
      )
      .orderBy(desc(trainingJobs.createdAt))
      .all()
      .filter((j) => (j.progress ?? 0) > 0);
  } catch {
    return [];
  }
}
