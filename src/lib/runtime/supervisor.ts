/**
 * Boot reconciliation and the supervisor tick.
 *
 * Two jobs, both of which the app previously had no answer for:
 *
 *  1. At boot, decide what to do about runs that were in flight when the
 *     process last ended. Until now they stayed `running` forever — a row
 *     claiming to be active with nothing behind it.
 *
 *  2. While running, notice work that has stopped making progress. An executor
 *     that dies without throwing leaves its row `running` indefinitely, which
 *     is both a lie and a leak.
 *
 * The resume half is modelled on `src/lib/blueprint/orchestrator.ts`
 * (`resumeAllPending` / `resumeOne`), the only resume path in the codebase that
 * already works. Its key idea is carried over: a step whose recorded hash still
 * matches is skipped rather than re-run, so replay does not repeat side
 * effects. Blueprint keeps its own implementation — it is the reference, not a
 * migration target.
 */

import { eq } from "drizzle-orm";
import log from "electron-log";

import { getDb } from "@/db";
import { osActivities, type OsActivityRow } from "@/db/agent_os_schema";
import {
  beginResume,
  failActivity,
  listResumable,
  listStale,
  markOrphanedRunsInterrupted,
  pruneCompleted,
} from "./activity_store";

const logger = log.scope("runtime-supervisor");

/**
 * A run stuck for this long with no update is treated as dead. Generous on
 * purpose: a long fine-tune or a large publish legitimately goes quiet for a
 * while, and killing real work is worse than a stale row lingering an hour.
 */
const STALE_AFTER_MS = 60 * 60 * 1000;

/** Terminal rows older than this are deleted so the table stays bounded. */
const PRUNE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

const SUPERVISOR_INTERVAL_MS = 60_000;

/** Give up rather than restart a run that keeps dying. */
const MAX_RESUME_ATTEMPTS = 3;

/**
 * A resumer knows how to continue one source's runs. Executors register their
 * own; a source with no registered resumer has its interrupted runs failed
 * explicitly rather than left in limbo.
 */
export type ActivityResumer = (activity: OsActivityRow) => Promise<void>;

const resumers = new Map<string, ActivityResumer>();

/** Register a resumer for one activity source (e.g. "mission", "background"). */
export function registerResumer(source: string, resume: ActivityResumer): void {
  resumers.set(source, resume);
}

let supervisorTimer: NodeJS.Timeout | null = null;

/**
 * Reconcile at boot: mark orphans, then resume what can be resumed and fail
 * the rest with a reason.
 *
 * Deliberately sequential and awaited — resuming ten runs at once on a cold
 * start competes with everything else booting, and these have already waited
 * however long the app was closed.
 */
export async function reconcileRunsAtBoot(): Promise<{
  interrupted: number;
  resumed: number;
  failed: number;
}> {
  const orphans = markOrphanedRunsInterrupted();
  if (orphans.length === 0) {
    return { interrupted: 0, resumed: 0, failed: 0 };
  }

  let resumed = 0;
  let failed = 0;

  for (const activity of listResumable()) {
    const attempt = (activity.attempt ?? 0) + 1;
    const resume = resumers.get(activity.source);

    if (!resume) {
      // Honest failure. Silently dropping it would leave the user believing
      // work is still queued.
      failActivity(
        activity.id,
        `Cannot resume: no resumer registered for source "${activity.source}".`,
      );
      failed += 1;
      continue;
    }

    if (attempt > MAX_RESUME_ATTEMPTS) {
      failActivity(
        activity.id,
        `Gave up after ${MAX_RESUME_ATTEMPTS} resume attempts.`,
      );
      failed += 1;
      continue;
    }

    try {
      beginResume(activity.id, attempt);
      await resume(activity);
      resumed += 1;
    } catch (err) {
      failActivity(activity.id, err);
      failed += 1;
    }
  }

  // Interrupted runs with no cursor were never in `listResumable`. Fail them
  // now so nothing is left claiming to be pending.
  const stranded = markStrandedInterrupted();

  logger.info(
    `boot reconcile: ${orphans.length} interrupted, ${resumed} resumed, ${failed + stranded} failed`,
  );
  return { interrupted: orphans.length, resumed, failed: failed + stranded };
}

/**
 * Fail interrupted runs that carry no cursor.
 *
 * Resuming one would mean replaying from the beginning, and these executors do
 * not record which side effects already happened — a re-run could send the same
 * email or mint the same asset twice.
 */
function markStrandedInterrupted(): number {
  // `listResumable` filters to rows WITH a cursor, so anything still
  // interrupted after the resume pass has none.
  try {
    const stranded = getDb()
      .select({ id: osActivities.id })
      .from(osActivities)
      .where(eq(osActivities.status, "interrupted"))
      .all();
    for (const row of stranded) {
      failActivity(
        row.id,
        "Interrupted by shutdown with no resume point recorded; not replayed because its steps are not known to be repeatable.",
      );
    }
    return stranded.length;
  } catch (err) {
    logger.warn("markStrandedInterrupted failed:", err);
    return 0;
  }
}

/** Start the periodic health pass. Idempotent. */
export function startSupervisor(): void {
  if (supervisorTimer) return;
  supervisorTimer = setInterval(() => {
    try {
      for (const stale of listStale(STALE_AFTER_MS)) {
        failActivity(
          stale.id,
          `No progress for over ${Math.round(STALE_AFTER_MS / 60000)} minutes; its executor is gone.`,
        );
        logger.warn(`failed stale run ${stale.id} (${stale.title})`);
      }
      pruneCompleted(PRUNE_AFTER_MS);
    } catch (err) {
      logger.warn("supervisor tick failed:", err);
    }
  }, SUPERVISOR_INTERVAL_MS);
  logger.info("supervisor started");
}

export function stopSupervisor(): void {
  if (supervisorTimer) clearInterval(supervisorTimer);
  supervisorTimer = null;
}
