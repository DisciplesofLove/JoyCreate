/**
 * Studio job queue — runs long-running video/audio work OUT of the IPC
 * `invoke` call so the renderer never blocks on a single round-trip.
 *
 * Each job is persisted to the `studio_jobs` table (survives app restart) and
 * its lifecycle is broadcast to every renderer window via the
 * `studio:job-progress` event. The renderer subscribes once and updates its
 * TanStack Query cache as events arrive.
 *
 * This module is intentionally provider-agnostic: callers supply a `run`
 * callback that does the actual work and reports fine-grained progress through
 * the {@link JobRunContext}. While a job runs without reporting progress, a
 * heartbeat slowly advances the bar toward 0.9 so the UI feels alive.
 */

import { randomUUID } from "node:crypto";

import { BrowserWindow } from "electron";
import { eq } from "drizzle-orm";
import log from "electron-log";

import { db } from "@/db";
import { studioJobs } from "@/db/schema";

const logger = log.scope("studio-jobs");

export const STUDIO_JOB_PROGRESS_CHANNEL = "studio:job-progress";

export type StudioJobKind = "generate-video" | "render" | "voiceover";
export type StudioJobStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "canceled";

/** Snapshot broadcast to renderers on every lifecycle change. */
export interface StudioJobEvent {
  id: string;
  kind: StudioJobKind;
  provider?: string | null;
  status: StudioJobStatus;
  progress: number;
  result?: Record<string, unknown> | null;
  error?: string | null;
}

/** Passed to a job's `run` callback to report progress and observe cancel. */
export interface JobRunContext {
  readonly jobId: string;
  /** Report fine-grained progress (clamped to 0..1). */
  setProgress(fraction: number): void;
  /** True once the job has been requested to cancel. */
  readonly canceled: boolean;
  /** Throws `JobCanceledError` if cancellation was requested. */
  throwIfCanceled(): void;
}

export class JobCanceledError extends Error {
  constructor() {
    super("Job canceled");
    this.name = "JobCanceledError";
  }
}

interface RunningJob {
  canceled: boolean;
  heartbeat?: NodeJS.Timeout;
  progress: number;
}

const runningJobs = new Map<string, RunningJob>();

function broadcast(event: StudioJobEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(STUDIO_JOB_PROGRESS_CHANNEL, event);
    }
  }
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

export interface EnqueueJobOptions {
  /** Optional client-supplied id so the renderer can track before commit. */
  id?: string;
  kind: StudioJobKind;
  provider?: string | null;
  params: Record<string, unknown>;
  /** Does the work; returns the result payload persisted as `resultJson`. */
  run: (ctx: JobRunContext) => Promise<Record<string, unknown>>;
}

/**
 * Create and start a job. Returns the job id IMMEDIATELY — the work runs in
 * the background and reports completion through `studio:job-progress`.
 */
export async function enqueueJob(options: EnqueueJobOptions): Promise<string> {
  const id = options.id ?? randomUUID();
  const provider = options.provider ?? null;

  await db.insert(studioJobs).values({
    id,
    kind: options.kind,
    provider,
    status: "queued",
    progress: 0,
    paramsJson: options.params,
  });

  broadcast({ id, kind: options.kind, provider, status: "queued", progress: 0 });

  // Fire-and-forget; lifecycle is reported via events + the DB row.
  void executeJob(id, options).catch((err) => {
    logger.error(`Unhandled job failure ${id}:`, err);
  });

  return id;
}

async function executeJob(id: string, options: EnqueueJobOptions): Promise<void> {
  const state: RunningJob = { canceled: false, progress: 0.05 };
  runningJobs.set(id, state);

  const provider = options.provider ?? null;
  const now = () => new Date();

  const emit = (
    status: StudioJobStatus,
    extra?: { result?: Record<string, unknown> | null; error?: string | null },
  ) => {
    broadcast({
      id,
      kind: options.kind,
      provider,
      status,
      progress: state.progress,
      result: extra?.result ?? null,
      error: extra?.error ?? null,
    });
  };

  await db
    .update(studioJobs)
    .set({ status: "running", progress: state.progress, startedAt: now(), updatedAt: now() })
    .where(eq(studioJobs.id, id));
  emit("running");

  // Heartbeat: nudge the bar toward 0.9 while the provider is silent.
  state.heartbeat = setInterval(() => {
    if (state.canceled) return;
    state.progress = Math.min(0.9, state.progress + 0.03);
    emit("running");
  }, 2000);

  const ctx: JobRunContext = {
    jobId: id,
    get canceled() {
      return state.canceled;
    },
    setProgress(fraction: number) {
      state.progress = clamp01(fraction);
      emit("running");
    },
    throwIfCanceled() {
      if (state.canceled) throw new JobCanceledError();
    },
  };

  try {
    const result = await options.run(ctx);
    clearInterval(state.heartbeat);
    if (state.canceled) {
      await db
        .update(studioJobs)
        .set({ status: "canceled", updatedAt: now(), finishedAt: now() })
        .where(eq(studioJobs.id, id));
      emit("canceled");
      return;
    }
    state.progress = 1;
    await db
      .update(studioJobs)
      .set({
        status: "succeeded",
        progress: 1,
        resultJson: result,
        updatedAt: now(),
        finishedAt: now(),
      })
      .where(eq(studioJobs.id, id));
    emit("succeeded", { result });
  } catch (err) {
    clearInterval(state.heartbeat);
    if (err instanceof JobCanceledError || state.canceled) {
      await db
        .update(studioJobs)
        .set({ status: "canceled", updatedAt: now(), finishedAt: now() })
        .where(eq(studioJobs.id, id));
      emit("canceled");
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`Job ${id} (${options.kind}) failed:`, message);
    await db
      .update(studioJobs)
      .set({ status: "failed", error: message, updatedAt: now(), finishedAt: now() })
      .where(eq(studioJobs.id, id));
    emit("failed", { error: message });
  } finally {
    runningJobs.delete(id);
  }
}

/**
 * Request cancellation of a running job. Best-effort: providers without
 * cancellation points finish their current step, but the result is discarded
 * and the job is marked `canceled`. Throws if the job is unknown.
 */
export async function cancelJob(id: string): Promise<void> {
  const state = runningJobs.get(id);
  if (state) {
    state.canceled = true;
    return;
  }
  // Not in-memory: it may have finished or be from a previous session.
  const row = await db.select().from(studioJobs).where(eq(studioJobs.id, id)).get();
  if (!row) throw new Error(`Job not found: ${id}`);
  if (row.status === "queued" || row.status === "running") {
    await db
      .update(studioJobs)
      .set({ status: "canceled", updatedAt: new Date(), finishedAt: new Date() })
      .where(eq(studioJobs.id, id));
  }
}
