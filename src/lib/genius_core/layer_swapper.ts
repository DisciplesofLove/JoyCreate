/**
 * Genius Core — Dynamic Layer Swapper.
 *
 * Bookkeeping module that owns a *VRAM byte budget* and decides which
 * model layers / context slots stay resident at any given moment.
 *
 * Design
 * ------
 * The swapper is intentionally **runtime-agnostic**: it does not know
 * about ONNX Runtime, transformers.js, or any tensor library. Callers
 * supply a `load` fn that returns an opaque handle, and `LayerSwapper`
 * tracks bytes, recency, and lifecycle around those handles. This keeps
 * Phase 3 testable without spinning up real GPU sessions.
 *
 * Semantics
 * ---------
 * • **Base layer** is *permanent*: pinned at `pinBase()` time and never
 *   evicted by LRU. Releasing it requires an explicit `shutdown()`.
 * • **Slots** are LRU-evicted to fit the remaining budget. Each
 *   `acquire(spec)` either returns the existing handle (and bumps
 *   recency) or loads it, evicting older slots until it fits.
 * • A slot whose own byte size exceeds `budgetBytes - baseBytes` is
 *   *unloadable*: `acquire()` rejects with a clear error rather than
 *   silently evicting the base.
 * • A slot tagged `pinned: true` is exempt from LRU eviction but still
 *   counts against the budget. Phase 4 uses this for the currently-open
 *   project's context slot.
 * • Concurrent calls for the same id are coalesced — a single in-flight
 *   load promise is shared across all awaiters.
 *
 * Side effects
 * ------------
 * The swapper *only* logs and optionally invokes an `onEvent` callback
 * for lifecycle transitions. It does not publish domain events directly
 * to keep this layer pure — the integrating backend forwards events.
 */

import log from "electron-log";

const logger = log.scope("genius_core/layer_swapper");

// ── Public types ─────────────────────────────────────────────────────────

export type LayerSwapperEvent =
  | { type: "base-pinned"; id: string; bytes: number }
  | { type: "slot-loaded"; id: string; bytes: number }
  | { type: "slot-touched"; id: string }
  | {
      type: "slot-released";
      id: string;
      bytes: number;
      reason: "explicit" | "lru" | "shutdown";
    }
  | { type: "budget-exceeded"; requestedBytes: number; budgetBytes: number };

export interface LayerSpec<H> {
  /** Stable id used as a cache key. */
  id: string;
  /** Estimated resident size in bytes. The swapper trusts this number. */
  bytes: number;
  /** Loader. Called at most once per (id) until released. */
  load: () => Promise<H>;
  /** Optional disposer for the handle. Always awaited; errors are logged. */
  dispose?: (handle: H) => Promise<void> | void;
  /** When true, this slot is exempt from LRU eviction. */
  pinned?: boolean;
}

export interface LayerSwapperOptions {
  /** Hard byte budget (base + slots). */
  budgetBytes: number;
  /** Logical/monotonic clock for recency. Defaults to `Date.now`. */
  clock?: () => number;
  /** Observer for lifecycle events (tests + UI status). */
  onEvent?: (event: LayerSwapperEvent) => void;
}

export interface LayerSwapperStatus {
  budgetBytes: number;
  baseBytes: number;
  baseId: string | null;
  slots: Array<{
    id: string;
    bytes: number;
    lastUsedMs: number;
    pinned: boolean;
  }>;
  totalBytes: number;
  freeBytes: number;
}

// ── Internal state ───────────────────────────────────────────────────────

interface ResidentSlot<H> {
  id: string;
  bytes: number;
  handle: H;
  lastUsedMs: number;
  pinned: boolean;
  dispose?: (h: H) => Promise<void> | void;
}

interface PendingLoad {
  promise: Promise<unknown>;
  bytes: number;
}

// ── LayerSwapper ─────────────────────────────────────────────────────────

export class LayerSwapper {
  private readonly budgetBytes: number;
  private readonly clock: () => number;
  private readonly emit: (e: LayerSwapperEvent) => void;

  private base: ResidentSlot<unknown> | null = null;
  private slots = new Map<string, ResidentSlot<unknown>>();
  private pending = new Map<string, PendingLoad>();
  private disposed = false;

  constructor(opts: LayerSwapperOptions) {
    if (!Number.isFinite(opts.budgetBytes) || opts.budgetBytes <= 0) {
      throw new Error("LayerSwapper requires a positive budgetBytes");
    }
    this.budgetBytes = opts.budgetBytes;
    this.clock = opts.clock ?? Date.now;
    this.emit = opts.onEvent ?? (() => {});
  }

  // ── Base layer ───────────────────────────────────────────────────────

  /**
   * Pins the base layer. Idempotent for the same id (returns the cached
   * handle). Throws if a different base is already pinned (callers must
   * `shutdown()` first to swap base models) or if the base alone exceeds
   * the budget.
   */
  async pinBase<H>(spec: LayerSpec<H>): Promise<H> {
    this.assertAlive();
    if (this.base) {
      if (this.base.id === spec.id) {
        return this.base.handle as H;
      }
      throw new Error(
        `LayerSwapper already has base '${this.base.id}' pinned; shutdown() before swapping`,
      );
    }
    if (spec.bytes > this.budgetBytes) {
      this.emit({
        type: "budget-exceeded",
        requestedBytes: spec.bytes,
        budgetBytes: this.budgetBytes,
      });
      throw new Error(
        `Base layer '${spec.id}' (${spec.bytes} B) exceeds budget (${this.budgetBytes} B)`,
      );
    }
    const handle = await spec.load();
    this.base = {
      id: spec.id,
      bytes: spec.bytes,
      handle,
      lastUsedMs: this.clock(),
      pinned: true,
      dispose: spec.dispose as ResidentSlot<unknown>["dispose"],
    };
    this.emit({ type: "base-pinned", id: spec.id, bytes: spec.bytes });
    return handle;
  }

  // ── Slots (LRU) ──────────────────────────────────────────────────────

  /**
   * Returns the handle for `spec.id`. If already resident, recency is
   * bumped. Otherwise loads via `spec.load()`, first evicting the least-
   * recently used non-pinned slots until the new slot fits within the
   * remaining budget. Concurrent acquires for the same id share one load
   * promise.
   */
  async acquire<H>(spec: LayerSpec<H>): Promise<H> {
    this.assertAlive();
    if (!Number.isFinite(spec.bytes) || spec.bytes < 0) {
      throw new Error(`Slot '${spec.id}' has invalid byte size: ${spec.bytes}`);
    }

    const existing = this.slots.get(spec.id);
    if (existing) {
      existing.lastUsedMs = this.clock();
      this.emit({ type: "slot-touched", id: spec.id });
      return existing.handle as H;
    }

    const inFlight = this.pending.get(spec.id);
    if (inFlight) return inFlight.promise as Promise<H>;

    if (spec.bytes > this.budgetBytes - this.baseBytes()) {
      this.emit({
        type: "budget-exceeded",
        requestedBytes: spec.bytes,
        budgetBytes: this.budgetBytes,
      });
      throw new Error(
        `Slot '${spec.id}' (${spec.bytes} B) cannot fit in remaining budget ` +
          `(${this.budgetBytes - this.baseBytes()} B after base)`,
      );
    }

    // Synchronously make room so a follow-up concurrent acquire sees an
    // honest free-byte count. Throws if all residents are pinned.
    this.evictForRequested(spec.bytes);

    const loadPromise = (async () => {
      try {
        const handle = await spec.load();
        this.slots.set(spec.id, {
          id: spec.id,
          bytes: spec.bytes,
          handle: handle as unknown,
          lastUsedMs: this.clock(),
          pinned: spec.pinned === true,
          dispose: spec.dispose as ResidentSlot<unknown>["dispose"],
        });
        this.emit({ type: "slot-loaded", id: spec.id, bytes: spec.bytes });
        return handle;
      } finally {
        this.pending.delete(spec.id);
      }
    })();

    this.pending.set(spec.id, {
      promise: loadPromise as Promise<unknown>,
      bytes: spec.bytes,
    });
    return loadPromise;
  }

  /** Bump recency without forcing a load. No-op if not resident. */
  touch(id: string): void {
    const s = this.slots.get(id);
    if (!s) return;
    s.lastUsedMs = this.clock();
    this.emit({ type: "slot-touched", id });
  }

  /**
   * Explicitly release a slot (e.g. Phase 9 one-shot shard streams).
   * Safe to call for non-resident ids.
   */
  async release(id: string): Promise<void> {
    const s = this.slots.get(id);
    if (!s) return;
    this.slots.delete(id);
    await this.runDispose(s);
    this.emit({
      type: "slot-released",
      id: s.id,
      bytes: s.bytes,
      reason: "explicit",
    });
  }

  /** Release every non-base slot. Used between project switches. */
  async releaseAllSlots(): Promise<void> {
    const ids = Array.from(this.slots.keys());
    for (const id of ids) {
      const s = this.slots.get(id);
      if (!s) continue;
      this.slots.delete(id);
      await this.runDispose(s);
      this.emit({
        type: "slot-released",
        id: s.id,
        bytes: s.bytes,
        reason: "explicit",
      });
    }
  }

  /**
   * Tear everything down — disposes base and all slots. After shutdown
   * the swapper rejects further calls.
   */
  async shutdown(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const ids = Array.from(this.slots.keys());
    for (const id of ids) {
      const s = this.slots.get(id);
      if (!s) continue;
      this.slots.delete(id);
      await this.runDispose(s);
      this.emit({
        type: "slot-released",
        id: s.id,
        bytes: s.bytes,
        reason: "shutdown",
      });
    }
    if (this.base) {
      const b = this.base;
      this.base = null;
      await this.runDispose(b);
      this.emit({
        type: "slot-released",
        id: b.id,
        bytes: b.bytes,
        reason: "shutdown",
      });
    }
    this.pending.clear();
  }

  // ── Introspection ────────────────────────────────────────────────────

  status(): LayerSwapperStatus {
    const slots = Array.from(this.slots.values())
      .map((s) => ({
        id: s.id,
        bytes: s.bytes,
        lastUsedMs: s.lastUsedMs,
        pinned: s.pinned,
      }))
      .sort((a, b) => b.lastUsedMs - a.lastUsedMs);
    const total = this.baseBytes() + slots.reduce((n, s) => n + s.bytes, 0);
    return {
      budgetBytes: this.budgetBytes,
      baseBytes: this.baseBytes(),
      baseId: this.base?.id ?? null,
      slots,
      totalBytes: total,
      freeBytes: Math.max(0, this.budgetBytes - total),
    };
  }

  // ── Internals ────────────────────────────────────────────────────────

  private baseBytes(): number {
    return this.base?.bytes ?? 0;
  }

  private slotsBytes(): number {
    let n = 0;
    for (const s of this.slots.values()) n += s.bytes;
    return n;
  }

  private assertAlive(): void {
    if (this.disposed) throw new Error("LayerSwapper has been shut down");
  }

  private evictForRequested(requestedBytes: number): void {
    const max = this.budgetBytes - this.baseBytes();
    const candidates = Array.from(this.slots.values())
      .filter((s) => !s.pinned)
      .sort((a, b) => a.lastUsedMs - b.lastUsedMs);
    let i = 0;
    while (this.slotsBytes() + requestedBytes > max && i < candidates.length) {
      const victim = candidates[i++];
      this.slots.delete(victim.id);
      // Dispose runs async but we don't await — we've already made room
      // in the bookkeeping; surface errors via the logger.
      void this.runDispose(victim).then(() => {
        this.emit({
          type: "slot-released",
          id: victim.id,
          bytes: victim.bytes,
          reason: "lru",
        });
      });
    }
    if (this.slotsBytes() + requestedBytes > max) {
      // Could not fit — every remaining slot is pinned.
      this.emit({
        type: "budget-exceeded",
        requestedBytes,
        budgetBytes: this.budgetBytes,
      });
      throw new Error(
        `Cannot fit ${requestedBytes} B: all resident slots are pinned`,
      );
    }
  }

  private async runDispose<H>(s: ResidentSlot<H>): Promise<void> {
    if (!s.dispose) return;
    try {
      await s.dispose(s.handle);
    } catch (err) {
      logger.warn(`Dispose threw for '${s.id}'`, err);
    }
  }
}

/** Convenience: convert a GB budget (settings input) to bytes. */
export function gbToBytes(gb: number): number {
  if (!Number.isFinite(gb) || gb <= 0) return 0;
  return Math.floor(gb * 1024 * 1024 * 1024);
}
