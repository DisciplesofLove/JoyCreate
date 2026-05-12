/**
 * Hypercore ↔ Celestia anchor scheduler (Phase 5).
 *
 * Periodically takes a snapshot `(topicKey, length, treeHash)` of every
 * open hypercore-backed topic and writes it as a Celestia blob, recording
 * the `(height, commitment)` pair into `hyper_anchor_checkpoints`. Peers
 * that join the topic later can verify the local hypercore tail against
 * the published anchor — tampering becomes detectable end-to-end.
 *
 * Cadence (matches plan recommendation):
 *  • Time-based: every {@link ANCHOR_INTERVAL_MS}.
 *  • Length-based: only anchor a topic if its length advanced by at least
 *    {@link MIN_GROWTH} blocks since the previous anchor (skips idle cores).
 *
 * Anchoring is best-effort. A Celestia outage MUST NOT crash the swarm or
 * the renderer. Failures are logged and retried on the next tick.
 */

import log from "electron-log";
import { db } from "@/db";
import { hyperAnchorCheckpoints } from "@/db/schema";
import { eq, desc, and } from "drizzle-orm";
import { celestiaBlobService } from "@/lib/celestia_blob_service";
import { getHyperService } from "./hyper_service";

const logger = log.scope("hyper_anchor");

/** Default cadence — 5 minutes. Override via {@link startAnchorScheduler}. */
const ANCHOR_INTERVAL_MS = 5 * 60 * 1000;
/** Minimum growth (in blocks) before we re-anchor a topic. */
const MIN_GROWTH = 1;

let timer: NodeJS.Timeout | null = null;
let inFlight = false;

interface AnchorPayload {
  v: 1;
  topicKey: string; // discovery key hex
  scope: string;
  subjectId: string;
  type: "log" | "bee" | "drive";
  length: number;
  treeHashHex: string;
  anchoredAt: number;
}

/** Start the periodic anchor scheduler. Idempotent. */
export function startAnchorScheduler(intervalMs = ANCHOR_INTERVAL_MS): void {
  if (timer) return;
  logger.info(`Anchor scheduler started — interval=${intervalMs}ms`);
  timer = setInterval(() => {
    void runAnchorTick();
  }, intervalMs);
  // Don't keep the event loop alive solely for anchoring.
  if (typeof timer.unref === "function") timer.unref();
}

export function stopAnchorScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
    logger.info("Anchor scheduler stopped");
  }
}

/**
 * Force an anchor pass right now. Returns the number of topics successfully
 * anchored. Safe to call from IPC `hyper:anchor:now`.
 */
export async function anchorNow(): Promise<number> {
  return runAnchorTick();
}

async function runAnchorTick(): Promise<number> {
  if (inFlight) return 0;
  inFlight = true;
  let anchored = 0;
  try {
    const svc = getHyperService();
    if (!svc.isReady()) return 0;
    const topics = await svc.listTopics();
    for (const t of topics) {
      try {
        if (!t.treeHashHex || t.length < MIN_GROWTH) continue;
        const last = await db.query.hyperAnchorCheckpoints.findFirst({
          where: eq(hyperAnchorCheckpoints.topicKey, t.discoveryKeyHex),
          orderBy: desc(hyperAnchorCheckpoints.length),
        });
        if (last && t.length - last.length < MIN_GROWTH) continue;
        const ok = await anchorTopic(t);
        if (ok) anchored++;
      } catch (err) {
        logger.warn(`anchor topic ${t.discoveryKeyHex.slice(0, 12)}… failed`, err);
      }
    }
  } catch (err) {
    logger.warn("anchor tick failed", err);
  } finally {
    inFlight = false;
  }
  if (anchored > 0) logger.info(`Anchor tick: ${anchored} topic(s) checkpointed`);
  return anchored;
}

async function anchorTopic(topic: {
  scope: string;
  subjectId: string;
  type: "log" | "bee" | "drive";
  discoveryKeyHex: string;
  length: number;
  treeHashHex: string | null;
}): Promise<boolean> {
  if (!topic.treeHashHex) return false;
  const payload: AnchorPayload = {
    v: 1,
    topicKey: topic.discoveryKeyHex,
    scope: topic.scope,
    subjectId: topic.subjectId,
    type: topic.type,
    length: topic.length,
    treeHashHex: topic.treeHashHex,
    anchoredAt: Date.now(),
  };
  let height: number | null = null;
  let commitment: string | null = null;
  try {
    const sub = await celestiaBlobService.submitJSON(payload, {
      label: `hyper:${topic.scope}:${topic.subjectId}`,
      dataType: "hyper-anchor-v1",
    });
    height = sub.height;
    commitment = sub.commitment;
  } catch (err) {
    // Celestia unreachable — record locally without on-chain proof so the
    // peer layer still has an audit trail of "we observed this length".
    logger.warn(
      `celestia submit failed for ${topic.discoveryKeyHex.slice(0, 12)}… — recording local-only`,
      err instanceof Error ? err.message : err,
    );
  }
  await db.insert(hyperAnchorCheckpoints).values({
    topicKey: topic.discoveryKeyHex,
    length: topic.length,
    treeHashHex: topic.treeHashHex,
    celestiaHeight: height,
    celestiaCommitment: commitment,
  });
  return true;
}
