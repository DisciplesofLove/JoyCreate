/**
 * Genius Core — per-project IPLD context slots (Phase 4).
 *
 * A *context slot* is a small IPLD dag-cbor block that wraps a project's
 * personalisation delta (a LoRA-style adapter on the head layer, encrypted
 * downstream by Phase 7). Slots form a Merkle DAG: every update points at
 * the previous slot CID, so the full personalisation history is auditable
 * without keeping every blob hot.
 *
 * This module is runtime-agnostic — the byte store (Helia) and the
 * registry (Drizzle `projects.context_slot_cid`) are injected, so every
 * branch can be unit-tested without touching IPFS or SQLite. The
 * production wiring lives in `setupContextSlotManager()` below.
 *
 * Lifecycle:
 *   • `createSlot(projectId, baseModelId, bytes)` — root slot for a project
 *   • `loadSlot(projectId)` — fetch + decode the current head slot
 *   • `updateSlot(projectId, baseModelId, bytes)` — append a child slot
 *   • `clearSlot(projectId)` — detach (does NOT unpin; that is a separate
 *     decision left to garbage collection / publish flows)
 *
 * Block shape is versioned (`version: 1`) so future migrations can grow
 * the schema without breaking historic CIDs.
 */

import * as dagCbor from "@ipld/dag-cbor";
import log from "electron-log";
import { mirrorGeniusCoreEvent } from "./hyper_bridge";

const logger = log.scope("genius_core.context_slots");

// ── Public block schema ──────────────────────────────────────────────────

export interface ContextSlotBlockV1 {
  version: 1;
  projectId: string;
  baseModelId: string;
  /**
   * Adapter weight payload. After Phase 7 this is Lit-encrypted ciphertext;
   * for Phases 4–6 it's the raw bytes from the LoRA pipeline.
   */
  adapterBytes: Uint8Array;
  /** Free-form provenance metadata, e.g. distillation receipt id. */
  metadata: Record<string, unknown>;
  /** Prior slot CID for Merkle DAG history; null on the root slot. */
  previousCid: string | null;
  createdAtMs: number;
}

// ── Injectable dependencies ──────────────────────────────────────────────

/** Block-level byte store; production impl wraps Helia. */
export interface ContextSlotStore {
  putBlock(bytes: Uint8Array): Promise<string>;
  getBlock(cid: string): Promise<Uint8Array>;
  pin(cid: string): Promise<void>;
  /**
   * Release a previously-pinned CID so Helia can reclaim its bytes on
   * next GC. Optional — implementations that don't support unpinning
   * may omit this; {@link ContextSlotManager.pruneHistory} treats the
   * absence as a soft "keep everything pinned" policy.
   */
  unpin?(cid: string): Promise<void>;
}

/** DB-backed mapping projectId → current slot CID. */
export interface ContextSlotRegistry {
  read(projectId: string): Promise<string | null>;
  write(projectId: string, cid: string | null): Promise<void>;
}

export type ContextSlotEvent =
  | {
      type: "created";
      projectId: string;
      cid: string;
      blockBytes: number;
      adapterBytes: number;
    }
  | {
      type: "updated";
      projectId: string;
      cid: string;
      previousCid: string;
      blockBytes: number;
      adapterBytes: number;
    }
  | {
      type: "rolled_back";
      projectId: string;
      /** Slot that was rolled back from (no longer head). */
      fromCid: string;
      /** Slot that is now the head; null if rollback cleared the project. */
      toCid: string | null;
    }
  | { type: "loaded"; projectId: string; cid: string; loadDurationMs: number }
  | { type: "cleared"; projectId: string; previousCid: string | null }
  | {
      type: "pruned";
      projectId: string;
      keptCids: string[];
      prunedCids: string[];
      unpinned: boolean;
    };

export interface ContextSlotManagerOptions {
  store: ContextSlotStore;
  registry: ContextSlotRegistry;
  onEvent?: (event: ContextSlotEvent) => void;
  /** Defaults to `() => Date.now()`. Override for deterministic tests. */
  now?: () => number;
}

// ── Manager ──────────────────────────────────────────────────────────────

export class ContextSlotManager {
  private readonly store: ContextSlotStore;
  private readonly registry: ContextSlotRegistry;
  private readonly onEvent?: (event: ContextSlotEvent) => void;
  private readonly now: () => number;

  constructor(opts: ContextSlotManagerOptions) {
    if (!opts.store) throw new Error("ContextSlotManager requires a store");
    if (!opts.registry) throw new Error("ContextSlotManager requires a registry");
    this.store = opts.store;
    this.registry = opts.registry;
    this.onEvent = opts.onEvent;
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * Build, pin, and register a fresh root slot. Throws if the project
   * already has a slot — caller should use {@link updateSlot} instead.
   */
  async createSlot(args: {
    projectId: string;
    baseModelId: string;
    adapterBytes: Uint8Array;
    metadata?: Record<string, unknown>;
  }): Promise<{ cid: string; block: ContextSlotBlockV1 }> {
    this.assertProjectId(args.projectId);
    this.assertBaseModelId(args.baseModelId);
    this.assertAdapterBytes(args.adapterBytes);

    const existing = await this.registry.read(args.projectId);
    if (existing) {
      throw new Error(
        `Project ${args.projectId} already has a context slot (${existing}); use updateSlot`,
      );
    }

    const block: ContextSlotBlockV1 = {
      version: 1,
      projectId: args.projectId,
      baseModelId: args.baseModelId,
      adapterBytes: args.adapterBytes,
      metadata: args.metadata ?? {},
      previousCid: null,
      createdAtMs: this.now(),
    };
    const encoded = dagCbor.encode(block);
    const cid = await this.store.putBlock(encoded);
    await this.store.pin(cid);
    await this.registry.write(args.projectId, cid);

    this.emit({
      type: "created",
      projectId: args.projectId,
      cid,
      blockBytes: encoded.byteLength,
      adapterBytes: args.adapterBytes.byteLength,
    });
    mirrorGeniusCoreEvent(args.projectId, {
      type: "slot",
      projectId: args.projectId,
      cid,
      baseModelId: args.baseModelId,
      previousCid: null,
      ts: this.now(),
    });
    return { cid, block };
  }

  /**
   * Fetch the registry pointer, pull the block, decode, and return.
   * Returns null when the project has no slot yet (fresh project).
   */
  async loadSlot(
    projectId: string,
  ): Promise<{ cid: string; block: ContextSlotBlockV1 } | null> {
    this.assertProjectId(projectId);
    const cid = await this.registry.read(projectId);
    if (!cid) return null;

    const startedMs = this.now();
    const raw = await this.store.getBlock(cid);
    const block = this.decode(raw);
    if (block.projectId !== projectId) {
      throw new Error(
        `Context slot ${cid} belongs to project ${block.projectId}, not ${projectId}`,
      );
    }
    const loadDurationMs = Math.max(0, this.now() - startedMs);

    this.emit({ type: "loaded", projectId, cid, loadDurationMs });
    return { cid, block };
  }

  /**
   * Append a child slot. Throws if there is no existing slot (caller
   * should use {@link createSlot}).
   */
  async updateSlot(args: {
    projectId: string;
    baseModelId: string;
    adapterBytes: Uint8Array;
    metadata?: Record<string, unknown>;
  }): Promise<{ cid: string; block: ContextSlotBlockV1 }> {
    this.assertProjectId(args.projectId);
    this.assertBaseModelId(args.baseModelId);
    this.assertAdapterBytes(args.adapterBytes);

    const previousCid = await this.registry.read(args.projectId);
    if (!previousCid) {
      throw new Error(
        `Project ${args.projectId} has no context slot yet; use createSlot`,
      );
    }

    const block: ContextSlotBlockV1 = {
      version: 1,
      projectId: args.projectId,
      baseModelId: args.baseModelId,
      adapterBytes: args.adapterBytes,
      metadata: args.metadata ?? {},
      previousCid,
      createdAtMs: this.now(),
    };
    const encoded = dagCbor.encode(block);
    const cid = await this.store.putBlock(encoded);
    await this.store.pin(cid);
    await this.registry.write(args.projectId, cid);

    this.emit({
      type: "updated",
      projectId: args.projectId,
      cid,
      previousCid,
      blockBytes: encoded.byteLength,
      adapterBytes: args.adapterBytes.byteLength,
    });
    mirrorGeniusCoreEvent(args.projectId, {
      type: "slot",
      projectId: args.projectId,
      cid,
      baseModelId: args.baseModelId,
      previousCid,
      ts: this.now(),
    });
    return { cid, block };
  }

  /**
   * Detach the slot from the project record. The underlying IPLD block
   * is left intact and pinned so historical decryption / publish flows
   * keep working — explicit garbage collection is a separate concern.
   */
  async clearSlot(projectId: string): Promise<void> {
    this.assertProjectId(projectId);
    const previousCid = await this.registry.read(projectId);
    if (!previousCid) return;
    await this.registry.write(projectId, null);
    this.emit({ type: "cleared", projectId, previousCid });
  }

  /**
   * Revert the project's head to its previous slot CID (one DAG hop back).
   * Used by the adapter quality scorer to auto-rollback a regressed
   * adapter. Returns the new head CID (null if the project's history
   * has only a single slot — in which case the project is cleared).
   */
  async rollbackSlot(
    projectId: string,
  ): Promise<{ fromCid: string; toCid: string | null }> {
    this.assertProjectId(projectId);
    const currentCid = await this.registry.read(projectId);
    if (!currentCid) {
      throw new Error(
        `Project ${projectId} has no context slot to rollback from`,
      );
    }
    const raw = await this.store.getBlock(currentCid);
    const block = this.decode(raw);
    const toCid = block.previousCid;
    await this.registry.write(projectId, toCid);
    this.emit({
      type: "rolled_back",
      projectId,
      fromCid: currentCid,
      toCid,
    });
    return { fromCid: currentCid, toCid };
  }

  /**
   * Walk the DAG backwards from the current slot, yielding `[cid, block]`
   * pairs newest-first. Useful for audit views and adapter diffs.
   */
  async *history(
    projectId: string,
  ): AsyncGenerator<{ cid: string; block: ContextSlotBlockV1 }, void, void> {
    this.assertProjectId(projectId);
    let cursor: string | null = await this.registry.read(projectId);
    const seen = new Set<string>();
    while (cursor) {
      if (seen.has(cursor)) {
        throw new Error(`Context slot history cycle detected at ${cursor}`);
      }
      seen.add(cursor);
      const raw = await this.store.getBlock(cursor);
      const block = this.decode(raw);
      yield { cid: cursor, block };
      cursor = block.previousCid;
    }
  }

  /**
   * Walk the DAG newest-first and unpin every slot beyond a retention
   * policy. Always preserves:
   *   • the current head + the most-recent `keepLast` slots
   *   • any slot whose metadata.published === true (on-chain anchors)
   *
   * IPLD blocks themselves are content-addressed and never mutated —
   * pruning only releases local pins so Helia can reclaim bytes on the
   * next GC. The chain's `previousCid` links remain intact; pruned
   * blocks may still be re-fetched from the swarm.
   *
   * Best-effort: a single unpin failure is logged and skipped so one
   * bad CID can't strand the rest of the policy.
   */
  async pruneHistory(
    projectId: string,
    opts?: { keepLast?: number },
  ): Promise<{ keptCids: string[]; prunedCids: string[] }> {
    this.assertProjectId(projectId);
    const keepLast = Math.max(1, opts?.keepLast ?? 10);
    const kept: string[] = [];
    const pruned: string[] = [];
    let index = 0;
    for await (const { cid, block } of this.history(projectId)) {
      const isPublished = block.metadata?.published === true;
      if (index < keepLast || isPublished) {
        kept.push(cid);
      } else {
        pruned.push(cid);
      }
      index += 1;
    }
    const canUnpin = typeof this.store.unpin === "function";
    if (canUnpin) {
      for (const cid of pruned) {
        try {
          await this.store.unpin!(cid);
        } catch (err) {
          logger.warn(`context slot prune: unpin ${cid} failed`, err);
        }
      }
    }
    this.emit({
      type: "pruned",
      projectId,
      keptCids: kept,
      prunedCids: pruned,
      unpinned: canUnpin,
    });
    return { keptCids: kept, prunedCids: pruned };
  }

  // ── internals ──────────────────────────────────────────────────────────

  private decode(raw: Uint8Array): ContextSlotBlockV1 {
    const decoded = dagCbor.decode(raw) as Partial<ContextSlotBlockV1>;
    if (!decoded || typeof decoded !== "object") {
      throw new Error("Context slot block decode produced a non-object");
    }
    if (decoded.version !== 1) {
      throw new Error(
        `Unsupported context slot block version: ${String(decoded.version)}`,
      );
    }
    if (
      typeof decoded.projectId !== "string" ||
      typeof decoded.baseModelId !== "string" ||
      !(decoded.adapterBytes instanceof Uint8Array) ||
      typeof decoded.createdAtMs !== "number" ||
      (decoded.previousCid !== null && typeof decoded.previousCid !== "string")
    ) {
      throw new Error("Context slot block failed schema validation");
    }
    return {
      version: 1,
      projectId: decoded.projectId,
      baseModelId: decoded.baseModelId,
      adapterBytes: decoded.adapterBytes,
      metadata: (decoded.metadata as Record<string, unknown>) ?? {},
      previousCid: decoded.previousCid,
      createdAtMs: decoded.createdAtMs,
    };
  }

  private assertProjectId(projectId: string): void {
    if (typeof projectId !== "string" || projectId.length === 0) {
      throw new Error("projectId must be a non-empty string");
    }
  }

  private assertBaseModelId(baseModelId: string): void {
    if (typeof baseModelId !== "string" || baseModelId.length === 0) {
      throw new Error("baseModelId must be a non-empty string");
    }
  }

  private assertAdapterBytes(bytes: Uint8Array): void {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
      throw new Error("adapterBytes must be a non-empty Uint8Array");
    }
  }

  private emit(event: ContextSlotEvent): void {
    if (!this.onEvent) return;
    try {
      this.onEvent(event);
    } catch (err) {
      logger.warn("context-slot event subscriber threw", err);
    }
  }
}

// ── Production wiring ────────────────────────────────────────────────────

/**
 * Build the production-mode singleton. Wires the Helia byte store and
 * the Drizzle `projects.context_slot_cid` column, and bridges events
 * onto the domain event bus so Phase 6/8 listeners light up.
 *
 * Called once during main-process boot after the DB + Helia are ready.
 * Tests should never reach this path — construct ContextSlotManager
 * directly with mocked deps instead.
 */
let liveManager: ContextSlotManager | null = null;

export function getContextSlotManager(): ContextSlotManager {
  if (!liveManager) {
    throw new Error(
      "Genius Core context slot manager not initialised — call setupContextSlotManager() first",
    );
  }
  return liveManager;
}

export function __resetContextSlotManagerForTests(): void {
  liveManager = null;
}

export async function setupContextSlotManager(): Promise<ContextSlotManager> {
  if (liveManager) return liveManager;

  // Lazy imports keep this module unit-testable in environments where
  // Helia / Drizzle / Electron are not loaded.
  const { heliaVerificationService } = await import("@/lib/helia_verification_service");
  const { getDb } = await import("@/db/index");
  const { projects } = await import("@/db/schema");
  const { eq } = await import("drizzle-orm");
  const { getDomainEventBus } = await import("@/lib/events/domain_event_bus");

  const store: ContextSlotStore = {
    async putBlock(bytes) {
      const res = await heliaVerificationService.addBytes(bytes);
      return res.cid;
    },
    async getBlock(cid) {
      return heliaVerificationService.getBytes(cid);
    },
    async pin(cid) {
      await heliaVerificationService.pinCid(cid);
    },
    async unpin(cid) {
      await heliaVerificationService.unpinCid(cid);
    },
  };

  const registry: ContextSlotRegistry = {
    async read(projectId) {
      const id = parseProjectId(projectId);
      const db = getDb();
      const row = await db
        .select({ cid: projects.contextSlotCid })
        .from(projects)
        .where(eq(projects.id, id))
        .get();
      if (!row) throw new Error(`Project ${projectId} not found`);
      return row.cid ?? null;
    },
    async write(projectId, cid) {
      const id = parseProjectId(projectId);
      const db = getDb();
      const result = await db
        .update(projects)
        .set({ contextSlotCid: cid })
        .where(eq(projects.id, id))
        .returning({ id: projects.id });
      if (result.length === 0) {
        throw new Error(`Project ${projectId} not found`);
      }
    },
  };

  const bus = getDomainEventBus();
  liveManager = new ContextSlotManager({
    store,
    registry,
    onEvent: (event) => {
      if (event.type === "loaded") {
        void bus.publish("genius_core.context_slot.loaded", {
          projectId: event.projectId,
          slotCid: event.cid,
          loadDurationMs: event.loadDurationMs,
        });
        return;
      }
      if (event.type === "pruned") {
        // Best-effort metadata mirror to the peer layer. Carries counts
        // only — never per-CID lists.
        mirrorGeniusCoreEvent(event.projectId, {
          type: "slot_prune",
          projectId: event.projectId,
          prunedCount: event.prunedCids.length,
          keptCount: event.keptCids.length,
          unpinned: event.unpinned,
          ts: Date.now(),
        });
        return;
      }
    },
  });
  logger.info("Context slot manager wired (Helia + projects table)");
  return liveManager;
}

function parseProjectId(projectId: string): number {
  const id = Number.parseInt(projectId, 10);
  if (!Number.isFinite(id) || id <= 0) {
    throw new Error(`projectId must be a positive integer string, got: ${projectId}`);
  }
  return id;
}
