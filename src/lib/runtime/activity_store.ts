/**
 * The one place an agent run is recorded.
 *
 * Before this, seven parallel schemes tracked "a run": `blueprint_runs`,
 * `autonomous_missions` (twice, in two different databases), agent-builder
 * execution JSON files, `agent_workspace_executions`, `openclaw_kanban_tasks`,
 * `a2a_invocations`. Only `blueprint_runs` could survive a crash, because only
 * it stored a cursor. Everything else recorded the outcome but not the
 * position, so a killed run was simply gone.
 *
 * `os_activities` already existed for exactly this purpose — its own doc
 * comment says other subsystems should emit here so the shell has one source of
 * truth — and was barely used. This module makes it the canonical record and
 * adds the resume state that `blueprint_runs` proved out.
 *
 * Executors keep their own domain tables; they additionally write a row here.
 * That is deliberate: dual-write first, so a bug in this path degrades
 * observability rather than losing a subsystem's real state.
 */

import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNotNull, lt } from "drizzle-orm";
import log from "electron-log";

import { getDb } from "@/db";
import {
  osActivities,
  type ActivityStepState,
  type OsActivityRow,
} from "@/db/agent_os_schema";

const logger = log.scope("activity-store");

export type ActivitySource = OsActivityRow["source"];
export type ActivityStatus = OsActivityRow["status"];

/** Statuses that mean "this run is over, one way or another". */
const TERMINAL: readonly ActivityStatus[] = [
  "completed",
  "failed",
  "cancelled",
];

export interface StartActivityInput {
  source: ActivitySource;
  title: string;
  subtitle?: string;
  /** Id of the underlying entity — mission id, task id, invocation id. */
  sourceRef?: string;
  /** The originating request, kept so a resumed run can rebuild its context. */
  input?: Record<string, unknown>;
  /** Supply to adopt an existing id (e.g. mirroring a blueprint run). */
  id?: string;
  metadata?: Record<string, unknown>;
}

/** Begin a run. Returns the activity id used by every later call. */
export function startActivity(input: StartActivityInput): string {
  const id = input.id ?? randomUUID();
  try {
    getDb()
      .insert(osActivities)
      .values({
        id,
        source: input.source,
        sourceRef: input.sourceRef ?? null,
        title: input.title,
        subtitle: input.subtitle ?? null,
        status: "running",
        progress: 0,
        inputJson: input.input ?? null,
        stepStateJson: {},
        metadataJson: input.metadata ?? null,
      })
      .run();

    // One running activity per underlying entity. A resumed run starts a fresh
    // activity while the interrupted one is still marked running; closing it
    // here keeps the count honest without waiting for the stale sweep.
    if (input.sourceRef) {
      supersedePriorRuns(input.source, input.sourceRef, id);
    }
  } catch (err) {
    // Never let bookkeeping take down the run it is describing.
    logger.warn(`startActivity failed for ${id}:`, err);
  }
  return id;
}

function touch(id: string, patch: Record<string, unknown>): void {
  try {
    getDb()
      .update(osActivities)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(osActivities.id, id))
      .run();
  } catch (err) {
    logger.warn(`activity update failed for ${id}:`, err);
  }
}

export function setProgress(id: string, progress: number): void {
  touch(id, { progress: Math.max(0, Math.min(100, Math.round(progress))) });
}

/**
 * Record where a run has got to.
 *
 * `currentStepId` is the resume cursor and `stepStateJson` the per-step record.
 * Both are written together so a crash between them cannot leave a cursor
 * pointing at a step with no state.
 */
export function recordStep(
  id: string,
  stepId: string,
  state: ActivityStepState,
): void {
  try {
    const row = getDb()
      .select({ stepStateJson: osActivities.stepStateJson })
      .from(osActivities)
      .where(eq(osActivities.id, id))
      .get();
    const steps = { ...(row?.stepStateJson ?? {}), [stepId]: state };
    touch(id, { currentStepId: stepId, stepStateJson: steps });
  } catch (err) {
    logger.warn(`recordStep failed for ${id}/${stepId}:`, err);
  }
}

export function completeActivity(id: string, progress = 100): void {
  touch(id, { status: "completed", progress, completedAt: new Date() });
}

export function failActivity(id: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  touch(id, {
    status: "failed",
    errorMessage: message.slice(0, 2000),
    completedAt: new Date(),
  });
}

export function cancelActivity(id: string): void {
  touch(id, { status: "cancelled", completedAt: new Date() });
}

/**
 * Close any older running activity for the same underlying entity.
 *
 * The invariant is one running activity per source entity. It gets violated by
 * the resume path: a resumer that requeues work — rather than continuing it in
 * place — leaves the original row `running` while the executor starts a fresh
 * one. Without this, the tray would count two runs where there is one, and the
 * stale row would linger until the hourly sweep noticed.
 *
 * Recorded as `completed` with a pointer to the successor, because the work was
 * not cancelled and did not fail — it moved.
 */
function supersedePriorRuns(
  source: ActivitySource,
  sourceRef: string,
  successorId: string,
): void {
  try {
    const priors = getDb()
      .select()
      .from(osActivities)
      .where(
        and(
          eq(osActivities.status, "running"),
          eq(osActivities.source, source),
          eq(osActivities.sourceRef, sourceRef),
        ),
      )
      .all();

    for (const prior of priors) {
      if (prior.id === successorId) continue;
      touch(prior.id, {
        status: "completed",
        completedAt: new Date(),
        metadataJson: {
          ...(prior.metadataJson ?? {}),
          supersededBy: successorId,
        },
      });
      logger.info(`activity ${prior.id} superseded by ${successorId}`);
    }
  } catch (err) {
    logger.warn("supersedePriorRuns failed:", err);
  }
}

/** Currently-running runs. Drives the tray's "N runs in progress". */
export function countRunning(): number {
  try {
    return getDb()
      .select({ id: osActivities.id })
      .from(osActivities)
      .where(eq(osActivities.status, "running"))
      .all().length;
  } catch {
    return 0;
  }
}

export function listActivities(limit = 50): OsActivityRow[] {
  try {
    return getDb()
      .select()
      .from(osActivities)
      .orderBy(desc(osActivities.startedAt))
      .limit(limit)
      .all();
  } catch (err) {
    logger.warn("listActivities failed:", err);
    return [];
  }
}

export function getActivity(id: string): OsActivityRow | undefined {
  try {
    return getDb()
      .select()
      .from(osActivities)
      .where(eq(osActivities.id, id))
      .get();
  } catch {
    return undefined;
  }
}

/**
 * Boot pass: every row still marked `running` belongs to a process that no
 * longer exists.
 *
 * No in-memory controller, timer or abort signal survives a restart, so such a
 * row cannot be running however recently it was updated. Marking them
 * `interrupted` — rather than leaving them `running` or guessing `failed` —
 * separates "we know this stopped" from "we know this went wrong", and gives
 * the resume pass something unambiguous to select on.
 *
 * Returns the rows it marked.
 */
export function markOrphanedRunsInterrupted(): OsActivityRow[] {
  try {
    const orphans = getDb()
      .select()
      .from(osActivities)
      .where(eq(osActivities.status, "running"))
      .all();

    if (orphans.length === 0) return [];

    getDb()
      .update(osActivities)
      .set({ status: "interrupted", updatedAt: new Date() })
      .where(eq(osActivities.status, "running"))
      .run();

    logger.info(
      `marked ${orphans.length} orphaned run(s) as interrupted at boot`,
    );
    return orphans;
  } catch (err) {
    logger.warn("markOrphanedRunsInterrupted failed:", err);
    return [];
  }
}

/**
 * Interrupted runs that carry enough state to continue.
 *
 * A run with no cursor cannot be resumed without repeating work whose side
 * effects may not be idempotent, so those are deliberately excluded — the
 * caller fails them explicitly instead of silently replaying them.
 */
export function listResumable(): OsActivityRow[] {
  try {
    return getDb()
      .select()
      .from(osActivities)
      .where(
        and(
          eq(osActivities.status, "interrupted"),
          isNotNull(osActivities.currentStepId),
        ),
      )
      .orderBy(desc(osActivities.startedAt))
      .all();
  } catch (err) {
    logger.warn("listResumable failed:", err);
    return [];
  }
}

/** Note a resume attempt, so a run that keeps dying can be given up on. */
export function beginResume(id: string, attempt: number): void {
  touch(id, { status: "running", attempt });
}

/**
 * Runs that have been going far longer than any run should. Used by the
 * supervisor tick to fail work whose executor died without throwing — the case
 * that otherwise leaves a row `running` forever and inflates the tray count.
 */
export function listStale(maxAgeMs: number): OsActivityRow[] {
  try {
    const cutoff = new Date(Date.now() - maxAgeMs);
    return getDb()
      .select()
      .from(osActivities)
      .where(
        and(eq(osActivities.status, "running"), lt(osActivities.updatedAt, cutoff)),
      )
      .all();
  } catch (err) {
    logger.warn("listStale failed:", err);
    return [];
  }
}

/** Prune finished rows so the activity table does not grow without bound. */
export function pruneCompleted(olderThanMs: number): number {
  try {
    const cutoff = new Date(Date.now() - olderThanMs);
    const doomed = getDb()
      .select({ id: osActivities.id })
      .from(osActivities)
      .where(
        and(
          inArray(osActivities.status, TERMINAL as ActivityStatus[]),
          lt(osActivities.updatedAt, cutoff),
        ),
      )
      .all();
    if (doomed.length === 0) return 0;
    getDb()
      .delete(osActivities)
      .where(
        inArray(
          osActivities.id,
          doomed.map((d) => d.id),
        ),
      )
      .run();
    return doomed.length;
  } catch (err) {
    logger.warn("pruneCompleted failed:", err);
    return 0;
  }
}
