/**
 * Genius Core ↔ Hypercore peer-layer bridge.
 *
 * Mirrors **metadata-only** Genius Core events (slot CIDs, edit-log batch
 * hashes, distillation receipt summaries) to the Hypercore peer layer
 * under scope `"genius-core"`, subject = projectId.
 *
 * Design goals:
 * - **Lightweight**: payloads capped at 2 KB; never raw edits, never
 *   adapter bytes (those live in IPLD / SQLite).
 * - **Opt-in**: gated by `settings.geniusCore.hyperReplicationEnabled`
 *   AND the runtime `hyperEnabled` global. Default off.
 * - **Fire-and-forget**: never throws; never blocks the caller. Failures
 *   log a warn and drop. Matches the provenance-mirror pattern in
 *   `src/lib/agent_provenance.ts`.
 * - **Single scope, three event types**: one append-only feed per project,
 *   discriminated by the `type` discriminator.
 */

import log from "electron-log";

const logger = log.scope("genius_core_hyper_bridge");

/** Maximum serialized event size in bytes. Larger events are dropped. */
const MAX_PAYLOAD_BYTES = 2048;

export type GeniusCoreSlotEvent = {
  type: "slot";
  projectId: string;
  cid: string;
  baseModelId: string;
  previousCid?: string | null;
  ts: number;
};

export type GeniusCoreEditsEvent = {
  type: "edits";
  projectId: string;
  /** SHA-256 of the canonical batch payload — never the entries themselves. */
  batchHash: string;
  count: number;
  firstSeq: number;
  lastSeq: number;
  ts: number;
};

export type GeniusCoreDistillEvent = {
  type: "distill";
  projectId: string;
  adapterId: string;
  method: "lora" | "qlora";
  sampleCount: number;
  finalLoss: number;
  durationMs: number;
  baseModelId: string;
  /**
   * Hex SHA-256 over the adapter weight bytes. Empty when the producing
   * trainer did not emit raw bytes. Consumers MUST verify this hash
   * against the fetched adapter CID payload before merging.
   */
  adapterHash: string;
  ts: number;
};

export type GeniusCoreRollbackEvent = {
  type: "rollback";
  projectId: string;
  /** Adapter that was rejected and rolled back. */
  adapterId: string;
  /** New (post-rollback) head slot CID; null if project has no prior slot. */
  revertedToCid: string | null;
  /** Eval score of the rejected adapter, in [0, 1]. */
  score: number;
  /** Score of the previous applied adapter that beat it. */
  baselineScore: number;
  ts: number;
};

/**
 * Metadata-only mirror of a context-slot history prune. Carries counts
 * and the surviving head CID, never any actual slot bytes or per-CID
 * lists (which could leak deltas).
 */
export type GeniusCoreSlotPruneEvent = {
  type: "slot_prune";
  projectId: string;
  /** Number of slots pruned (removed from history). */
  prunedCount: number;
  /** Number of slots retained after pruning. */
  keptCount: number;
  /** Whether the underlying byte store unpinned the dropped CIDs. */
  unpinned: boolean;
  ts: number;
};

export type GeniusCoreHyperEvent =
  | GeniusCoreSlotEvent
  | GeniusCoreEditsEvent
  | GeniusCoreDistillEvent
  | GeniusCoreRollbackEvent
  | GeniusCoreSlotPruneEvent;

/**
 * Best-effort mirror of a Genius Core metadata event to the Hypercore peer
 * layer. Fire-and-forget: returns immediately; never throws.
 *
 * Safe to call from any Genius Core hot path *after* the underlying SQLite
 * / IPLD write has committed.
 */
export function mirrorGeniusCoreEvent(
  projectId: string,
  event: GeniusCoreHyperEvent,
): void {
  if (!projectId || typeof projectId !== "string") return;

  void (async () => {
    try {
      // Settings gate — dynamic import to avoid main↔renderer coupling.
      const { readSettings } = await import("@/main/settings");
      const settings = readSettings();
      if (settings.geniusCore?.hyperReplicationEnabled !== true) return;
      // Respect global hyper kill-switch.
      if ((settings as { hyperEnabled?: boolean }).hyperEnabled === false) {
        return;
      }

      // Size guard — keep the peer layer lightweight.
      const serialized = JSON.stringify(event);
      if (serialized.length > MAX_PAYLOAD_BYTES) {
        logger.warn(
          `mirror skipped: payload ${serialized.length}B exceeds ${MAX_PAYLOAD_BYTES}B cap (type=${event.type}, project=${projectId})`,
        );
        return;
      }

      const { HyperLogStore } = await import("@/lib/hyper/hyper_log_store");
      const store = new HyperLogStore<GeniusCoreHyperEvent>(
        "genius-core",
        projectId,
      );
      await store.tryAppend(event);
    } catch (err) {
      logger.warn(
        "mirrorGeniusCoreEvent failed",
        err instanceof Error ? err.message : err,
      );
    }
  })();
}
