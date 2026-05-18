/**
 * Genius Core — Federated Distillation Aggregator (Phase 9 seed).
 *
 * Merges adapter weights produced by *other peers* working on the same
 * project into a single local adapter. The Hypercore peer layer broadcasts
 * **metadata-only** `distill` receipts under scope `"genius-core"`
 * (subject = `projectId`). This module:
 *
 *   1. Reads recent peer `distill` events for the project.
 *   2. Filters by minimum sample count / max loss to reject obvious noise.
 *   3. Gates each candidate through a Lit Protocol ACL check — a peer must
 *      hold a valid lease (or explicit allow-list entry) to contribute to
 *      *this* user's local adapter.
 *   4. Fetches the candidate adapter weights via an injectable byte source
 *      (CID over Helia in production, in-memory map in tests).
 *   5. Computes a weighted average where
 *      `weight = sampleCount / max(0.01, finalLoss)` and merges top-K.
 *   6. Hands the merged Float32Array back through an injectable applier
 *      that creates the new context slot, and publishes the
 *      `genius_core.adapter.aggregated` domain event.
 *
 * Every external dependency is injected so the merge math + selection
 * policy can be unit-tested with deterministic doubles. The live wiring
 * lives in {@link setupFederatedAggregator}.
 *
 * Privacy posture
 * ---------------
 * - Adapter *bytes* never leave the contributing peer's device unless
 *   that peer has explicitly opted in (`hyperReplicationEnabled` AND
 *   `federatedDistillationEnabled` AND `publishAdapterCids`).
 * - On the receiver side, this module is a strict pull: nothing runs
 *   unless `federatedDistillationEnabled === true` AND the ACL gate
 *   approves the candidate.
 * - The module never mutates the local adapter directly; it only invokes
 *   the injected `applyMergedAdapter`, which in production wraps the
 *   merged bytes into a new context slot via {@link ContextSlotManager}.
 */

import log from "electron-log";
import { createHash } from "crypto";

const logger = log.scope("genius_core.federated_aggregator");

/** Hex SHA-256 helper — mirrors `distillation_scheduler.sha256Hex` so both
 *  sides of the producer/consumer flow agree on the canonical digest. */
function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Snapshot of a peer distillation event sufficient to score + fetch. */
export interface AggregationCandidate {
  /** Adapter id (also the IPLD CID in production). */
  adapterId: string;
  /** Stable identifier for the peer that produced this adapter. */
  peerPubkey: string;
  /** Base model the adapter was trained on top of — must match locally. */
  baseModelId: string;
  /** Number of training samples the peer used. */
  sampleCount: number;
  /** Final training loss reported by the peer. */
  finalLoss: number;
  /** Epoch ms when the peer produced the adapter. */
  ts: number;
  /**
   * Optional hex SHA-256 the peer published alongside the adapter.
   * When set, the aggregator verifies fetched bytes against this hash
   * (after byte-array conversion) and skips the candidate on mismatch.
   * Empty / undefined disables verification — useful for legacy peers
   * but logged at warn level when seen.
   */
  expectedHash?: string;
}

export interface AggregatorDeps {
  /** Lists recent peer distill candidates for the given project. */
  readPeerCandidates(projectId: string): Promise<AggregationCandidate[]>;
  /**
   * Lit ACL gate. Return `true` to allow the candidate to contribute.
   * Should be deny-by-default — implementations check that the candidate
   * peer holds a valid lease or sits on the project's allow-list.
   */
  aclGate(candidate: AggregationCandidate, projectId: string): Promise<boolean>;
  /** Fetches the raw float32 adapter weights for a candidate. */
  fetchAdapterWeights(candidate: AggregationCandidate): Promise<Float32Array>;
  /** Persists the merged adapter as a new context slot for the project. */
  applyMergedAdapter(args: {
    projectId: string;
    merged: Float32Array;
    sources: AggregationCandidate[];
  }): Promise<{ newSlotCid: string | null }>;
  /** Publishes the domain event on success. */
  publishAggregated?: (payload: {
    projectId: string;
    candidatesUsed: number;
    totalWeight: number;
    sourceAdapterIds: string[];
    newSlotCid: string | null;
  }) => Promise<void> | void;
  now?: () => number;
}

export interface FederatedAggregatorOptions {
  /** Maximum candidates merged per pass. Default 5. */
  topK?: number;
  /** Minimum samples a candidate must have to qualify. Default 16. */
  minSampleCount?: number;
  /** Max loss a candidate may have to qualify. Default 5.0. */
  maxLoss?: number;
  /**
   * Optional base-model filter: when set, only candidates whose
   * `baseModelId` matches will be considered. Recommended.
   */
  baseModelId?: string;
}

export interface AggregateRunArgs {
  projectId: string;
}

export interface AggregateRunResult {
  /** True when a merged adapter was applied. */
  merged: boolean;
  /** Total peer events read from Hypercore before filtering. */
  candidatesRead: number;
  /** Candidates that passed quality + ACL gates. */
  candidatesUsed: number;
  /** Sum of weight scores across used candidates. */
  totalWeight: number;
  /** CID of the new slot, if persisted. */
  newSlotCid: string | null;
  /** Adapter ids that contributed to the merge. */
  sourceAdapterIds: string[];
}

// ─────────────────────────────────────────────────────────────────────────
// Pure scoring helpers (exported for tests)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Inverse-loss × sample-count weighting. Higher is better.
 * `maxLoss → 0.01` so a near-perfect-fit candidate cannot dominate via
 * divide-by-zero.
 */
export function weightFor(c: AggregationCandidate): number {
  const samples = Math.max(0, c.sampleCount);
  const loss = Math.max(0.01, c.finalLoss);
  return samples / loss;
}

/**
 * Weighted average of equal-length Float32Arrays.
 * Throws if `arrays.length === 0` or any array length differs.
 */
export function weightedAverage(
  arrays: Float32Array[],
  weights: number[],
): Float32Array {
  if (arrays.length === 0) throw new Error("weightedAverage: no arrays");
  if (arrays.length !== weights.length) {
    throw new Error("weightedAverage: arrays/weights length mismatch");
  }
  const len = arrays[0].length;
  for (let i = 1; i < arrays.length; i++) {
    if (arrays[i].length !== len) {
      throw new Error(
        `weightedAverage: array ${i} length ${arrays[i].length} != ${len}`,
      );
    }
  }
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  if (totalWeight <= 0) {
    throw new Error("weightedAverage: totalWeight must be positive");
  }
  const out = new Float32Array(len);
  for (let i = 0; i < arrays.length; i++) {
    const w = weights[i] / totalWeight;
    const arr = arrays[i];
    for (let j = 0; j < len; j++) {
      out[j] += arr[j] * w;
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// Aggregator
// ─────────────────────────────────────────────────────────────────────────

export class FederatedAggregator {
  private readonly topK: number;
  private readonly minSampleCount: number;
  private readonly maxLoss: number;
  private readonly baseModelId: string | undefined;

  constructor(
    private readonly deps: AggregatorDeps,
    opts: FederatedAggregatorOptions = {},
  ) {
    this.topK = opts.topK ?? 5;
    this.minSampleCount = opts.minSampleCount ?? 16;
    this.maxLoss = opts.maxLoss ?? 5.0;
    this.baseModelId = opts.baseModelId;
    if (this.topK <= 0) throw new Error("topK must be > 0");
    if (this.minSampleCount < 0) {
      throw new Error("minSampleCount must be >= 0");
    }
    if (this.maxLoss <= 0) throw new Error("maxLoss must be > 0");
  }

  async run(args: AggregateRunArgs): Promise<AggregateRunResult> {
    const { projectId } = args;
    if (!projectId) throw new Error("projectId is required");

    const all = await this.deps.readPeerCandidates(projectId);
    const candidatesRead = all.length;

    // Filter by quality gates + optional base-model match.
    const qualified = all.filter((c) => {
      if (c.sampleCount < this.minSampleCount) return false;
      if (!Number.isFinite(c.finalLoss) || c.finalLoss > this.maxLoss) {
        return false;
      }
      if (this.baseModelId && c.baseModelId !== this.baseModelId) {
        return false;
      }
      return true;
    });

    // ACL gate each survivor — deny-by-default.
    const acl: AggregationCandidate[] = [];
    for (const c of qualified) {
      try {
        const allowed = await this.deps.aclGate(c, projectId);
        if (allowed) acl.push(c);
      } catch (err) {
        logger.warn("aclGate threw (treating as deny)", c.adapterId, err);
      }
    }

    // Sort by weight desc, take top-K.
    const ranked = acl
      .map((c) => ({ c, w: weightFor(c) }))
      .filter((x) => x.w > 0)
      .sort((a, b) => b.w - a.w)
      .slice(0, this.topK);

    if (ranked.length === 0) {
      logger.info("no qualifying peer candidates", {
        projectId,
        candidatesRead,
      });
      return {
        merged: false,
        candidatesRead,
        candidatesUsed: 0,
        totalWeight: 0,
        newSlotCid: null,
        sourceAdapterIds: [],
      };
    }

    // Fetch + merge.
    const arrays: Float32Array[] = [];
    const weights: number[] = [];
    const used: AggregationCandidate[] = [];
    for (const { c, w } of ranked) {
      try {
        const bytes = await this.deps.fetchAdapterWeights(c);
        if (!(bytes instanceof Float32Array) || bytes.length === 0) {
          logger.warn(
            "fetchAdapterWeights returned empty/invalid (skipping)",
            c.adapterId,
          );
          continue;
        }
        // Integrity check against the peer-published hash, when present.
        // Float32 bytes are hashed in their underlying buffer view so the
        // result matches what the producer would compute over the
        // serialized adapter (little-endian on every supported platform).
        if (c.expectedHash && c.expectedHash.length > 0) {
          const view = new Uint8Array(
            bytes.buffer,
            bytes.byteOffset,
            bytes.byteLength,
          );
          const actual = sha256Hex(view);
          if (actual !== c.expectedHash) {
            logger.warn(
              "adapter hash mismatch (skipping)",
              c.adapterId,
              { expected: c.expectedHash, actual },
            );
            continue;
          }
        }
        if (arrays.length > 0 && bytes.length !== arrays[0].length) {
          logger.warn(
            "adapter shape mismatch (skipping)",
            c.adapterId,
            bytes.length,
            arrays[0].length,
          );
          continue;
        }
        arrays.push(bytes);
        weights.push(w);
        used.push(c);
      } catch (err) {
        logger.warn(
          "fetchAdapterWeights failed (skipping)",
          c.adapterId,
          err instanceof Error ? err.message : err,
        );
      }
    }

    if (arrays.length === 0) {
      return {
        merged: false,
        candidatesRead,
        candidatesUsed: 0,
        totalWeight: 0,
        newSlotCid: null,
        sourceAdapterIds: [],
      };
    }

    const merged = weightedAverage(arrays, weights);
    const totalWeight = weights.reduce((a, b) => a + b, 0);

    const apply = await this.deps.applyMergedAdapter({
      projectId,
      merged,
      sources: used,
    });

    const sourceAdapterIds = used.map((c) => c.adapterId);
    if (this.deps.publishAggregated) {
      try {
        await this.deps.publishAggregated({
          projectId,
          candidatesUsed: used.length,
          totalWeight,
          sourceAdapterIds,
          newSlotCid: apply.newSlotCid,
        });
      } catch (err) {
        logger.warn("publishAggregated failed", err);
      }
    }

    logger.info("federated aggregation applied", {
      projectId,
      candidatesUsed: used.length,
      totalWeight,
      newSlotCid: apply.newSlotCid,
    });

    return {
      merged: true,
      candidatesRead,
      candidatesUsed: used.length,
      totalWeight,
      newSlotCid: apply.newSlotCid,
      sourceAdapterIds,
    };
  }
}
