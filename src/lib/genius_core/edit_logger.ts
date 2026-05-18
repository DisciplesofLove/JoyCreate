/**
 * Genius Core — order-respecting edit logger (Phase 5).
 *
 * Buffered, debounced capture of editor operations. The captured stream
 * preserves causal order via a monotonic per-session sequence number so
 * downstream distillation can reconstruct the exact sequence of edits
 * even when wall-clock timestamps collide.
 *
 * ## Privacy hard-gate
 *
 * Records are ONLY produced when BOTH of these hold at capture time:
 *
 *   1. `settings.geniusCore.keystrokeLoggerEnabled === true`
 *   2. `settings.telemetryConsent === "opted_in"`
 *
 * The check runs on every `record(...)` call and is delegated to a
 * `PrivacyGate` function (default: live read of UserSettings). When the
 * gate is closed, calls are silently dropped — never queued, never
 * flushed, never written to disk.
 *
 * Plaintext is never persisted. The hash field stores a SHA-256 of the
 * text payload; the in-memory buffer holds plaintext only between
 * `record()` and the next `flush()` (≤ 300 ms).
 *
 * ## Runtime-agnostic
 *
 * Like the rest of `src/lib/genius_core/`, this module accepts injected
 * `gate`, `writer`, and `clock` for tests. A production singleton is
 * wired by `setupEditLogger()` against settings + drizzle.
 */

import { createHash } from "node:crypto";

import log from "electron-log";
import { mirrorGeniusCoreEvent } from "./hyper_bridge";

const logger = log.scope("genius-core/edit-logger");

export type EditOp = "insert" | "delete" | "cursor" | "ai_accept" | "ai_reject";

export interface EditRange {
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
}

/**
 * Caller-supplied record. `text` is optional (cursor/ai_* ops carry no
 * text); when present it is hashed and its length captured.
 */
export interface RecordInput {
  projectId: number;
  fileId: string;
  op: EditOp;
  range: EditRange;
  text?: string;
  /** Override capture time for deterministic tests. Defaults to `clock()`. */
  occurredAtMs?: number;
}

export interface EditLogEntry {
  projectId: number;
  fileId: string;
  op: EditOp;
  range: EditRange;
  textHash: string | null;
  textLength: number;
  sequence: number;
  occurredAtMs: number;
}

export type PrivacyGate = (projectId?: number) => boolean;
export type EditLogWriter = (entries: EditLogEntry[]) => Promise<void>;
export type Clock = () => number;

export interface EditLoggerOptions {
  /** Returns true when capture is currently permitted. */
  gate: PrivacyGate;
  /** Persists a batch of entries. Called with a non-empty array. */
  writer: EditLogWriter;
  /** Debounce window in ms before a non-empty buffer auto-flushes. */
  debounceMs?: number;
  /** Hard cap on buffer size; oldest entries are dropped on overflow. */
  maxBufferSize?: number;
  /**
   * Optional sink invoked whenever the buffer overflows and old entries
   * are dropped. Errors thrown by the publisher are caught + logged so
   * the recording path is never blocked by a misbehaving event bus.
   * Production wiring publishes `genius_core.edit_log.dropped` here.
   */
  publishDropped?: (payload: EditLogDroppedPayload) => void;
  /** Wall-clock ms provider. Defaults to `Date.now`. */
  clock?: Clock;
  /** Schedules a deferred callback. Defaults to `setTimeout`. */
  scheduler?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  /** Cancels a scheduled callback. Defaults to `clearTimeout`. */
  cancel?: (handle: ReturnType<typeof setTimeout>) => void;
}

/** Payload emitted on overflow — mirrored to the domain event bus. */
export interface EditLogDroppedPayload {
  /** Project the dropped entries belonged to, when uniform; else null. */
  projectId: number | null;
  /** Entries dropped in *this* overflow event. */
  droppedCount: number;
  /** Running total of entries dropped across the logger's lifetime. */
  totalDropped: number;
  /** Buffer size cap at the moment of overflow. */
  bufferSize: number;
  /** Clock timestamp of the overflow. */
  atMs: number;
}

const DEFAULT_DEBOUNCE_MS = 300;
const DEFAULT_MAX_BUFFER = 1024;

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function assertRange(range: EditRange): void {
  if (!range || typeof range !== "object") {
    throw new Error("edit-logger: range is required");
  }
  for (const key of ["startLine", "startCol", "endLine", "endCol"] as const) {
    const v = (range as Record<string, unknown>)[key];
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
      throw new Error(`edit-logger: range.${key} must be a non-negative finite number`);
    }
  }
}

const VALID_OPS: ReadonlySet<EditOp> = new Set([
  "insert",
  "delete",
  "cursor",
  "ai_accept",
  "ai_reject",
]);

/**
 * Buffered, gated edit logger. Single-session — instantiate per process
 * (main); the renderer side speaks through IPC, not a second instance.
 */
export class EditLogger {
  private readonly gate: PrivacyGate;
  private readonly writer: EditLogWriter;
  private readonly debounceMs: number;
  private readonly maxBufferSize: number;
  private readonly clock: Clock;
  private readonly schedule: NonNullable<EditLoggerOptions["scheduler"]>;
  private readonly cancelTimer: NonNullable<EditLoggerOptions["cancel"]>;

  private buffer: EditLogEntry[] = [];
  private nextSequence = 1;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushing: Promise<void> | null = null;
  private disposed = false;
  private droppedOnOverflow = 0;
  private readonly publishDropped?: (payload: EditLogDroppedPayload) => void;

  constructor(opts: EditLoggerOptions) {
    if (typeof opts?.gate !== "function") {
      throw new Error("EditLogger requires a gate function");
    }
    if (typeof opts?.writer !== "function") {
      throw new Error("EditLogger requires a writer function");
    }
    this.gate = opts.gate;
    this.writer = opts.writer;
    this.debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.maxBufferSize = opts.maxBufferSize ?? DEFAULT_MAX_BUFFER;
    this.clock = opts.clock ?? Date.now;
    this.schedule = opts.scheduler ?? setTimeout;
    this.cancelTimer = opts.cancel ?? clearTimeout;
    this.publishDropped = opts.publishDropped;
  }

  /**
   * Capture one editor event. Returns true when the event was buffered,
   * false when the privacy gate is closed or the logger is disposed.
   * Throws ONLY for malformed inputs (programming errors).
   */
  record(input: RecordInput): boolean {
    if (this.disposed) return false;
    if (!input || typeof input !== "object") {
      throw new Error("edit-logger: record requires an input object");
    }
    if (!Number.isInteger(input.projectId) || input.projectId <= 0) {
      throw new Error("edit-logger: projectId must be a positive integer");
    }
    if (typeof input.fileId !== "string" || input.fileId.length === 0) {
      throw new Error("edit-logger: fileId must be a non-empty string");
    }
    if (!VALID_OPS.has(input.op)) {
      throw new Error(`edit-logger: unknown op "${input.op}"`);
    }
    assertRange(input.range);

    // Privacy gate is checked AFTER input validation so misuse still
    // surfaces during development regardless of consent state.
    if (!this.isGateOpen(input.projectId)) return false;

    const text = input.text;
    if (text !== undefined && typeof text !== "string") {
      throw new Error("edit-logger: text must be a string when provided");
    }

    const entry: EditLogEntry = {
      projectId: input.projectId,
      fileId: input.fileId,
      op: input.op,
      range: { ...input.range },
      textHash: text && text.length > 0 ? sha256(text) : null,
      textLength: text ? text.length : 0,
      sequence: this.nextSequence++,
      occurredAtMs: input.occurredAtMs ?? this.clock(),
    };

    this.buffer.push(entry);
    if (this.buffer.length > this.maxBufferSize) {
      // Drop oldest — we'd rather lose history than block the editor.
      const overflow = this.buffer.length - this.maxBufferSize;
      const dropped = this.buffer.splice(0, overflow);
      this.droppedOnOverflow += overflow;
      logger.warn(`buffer overflow: dropped ${overflow} oldest entries`);
      if (this.publishDropped) {
        // Determine a single projectId only when *all* dropped entries
        // came from the same project — otherwise null so the UI
        // shows a global banner instead of one stuck to a project.
        const firstProject = dropped[0]?.projectId ?? null;
        const uniform = dropped.every((e) => e.projectId === firstProject);
        try {
          this.publishDropped({
            projectId: uniform ? firstProject : null,
            droppedCount: overflow,
            totalDropped: this.droppedOnOverflow,
            bufferSize: this.maxBufferSize,
            atMs: this.clock(),
          });
        } catch (err) {
          logger.warn("publishDropped threw (ignored)", err);
        }
      }
    }

    this.scheduleFlush();
    return true;
  }

  /**
   * Force-flush the buffer now. Resolves once the in-flight write (if
   * any) settles. Safe to await between tests.
   */
  async flush(): Promise<void> {
    if (this.timer) {
      this.cancelTimer(this.timer);
      this.timer = null;
    }
    if (this.flushing) await this.flushing;
    if (this.buffer.length === 0) return;

    const batch = this.buffer;
    this.buffer = [];
    this.flushing = (async () => {
      try {
        await this.writer(batch);
        mirrorFlushedBatch(batch);
      } catch (err) {
        // Restore the batch at the head so the next flush retries.
        this.buffer = batch.concat(this.buffer);
        logger.error("writer failed; entries restored for retry", err);
        throw err;
      } finally {
        this.flushing = null;
      }
    })();
    await this.flushing;
  }

  /**
   * Cancel pending flushes and forget unwritten entries. Use on settings
   * toggle-off or shutdown.
   */
  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.timer) {
      this.cancelTimer(this.timer);
      this.timer = null;
    }
    if (this.flushing) {
      try {
        await this.flushing;
      } catch {
        /* already logged */
      }
    }
    this.buffer = [];
  }

  /** Diagnostic snapshot. */
  status(): {
    bufferSize: number;
    nextSequence: number;
    droppedOnOverflow: number;
    disposed: boolean;
    gateOpen: boolean;
  } {
    return {
      bufferSize: this.buffer.length,
      nextSequence: this.nextSequence,
      droppedOnOverflow: this.droppedOnOverflow,
      disposed: this.disposed,
      gateOpen: this.isGateOpen(),
    };
  }

  private isGateOpen(projectId?: number): boolean {
    try {
      return this.gate(projectId) === true;
    } catch (err) {
      logger.warn("privacy gate threw; treating as closed", err);
      return false;
    }
  }

  private scheduleFlush(): void {
    if (this.timer) return;
    this.timer = this.schedule(() => {
      this.timer = null;
      this.flush().catch((err) => {
        logger.error("scheduled flush failed", err);
      });
    }, this.debounceMs);
  }
}

// ── Production singleton wiring ──────────────────────────────────────────

let liveLogger: EditLogger | null = null;

export function getEditLogger(): EditLogger {
  if (!liveLogger) {
    throw new Error("Genius Core edit logger not initialised");
  }
  return liveLogger;
}

/** Test helper. Do NOT call from production code paths. */
export function __resetEditLoggerForTests(): void {
  liveLogger = null;
}

/**
 * Lazy initialiser. Idempotent — repeat calls return the existing
 * instance. Reads settings on every gate check so toggling consent
 * mid-session takes effect immediately.
 */
export async function setupEditLogger(): Promise<EditLogger> {
  if (liveLogger) return liveLogger;

  const [{ readSettings }, { getDb }, { editLogEntries }] = await Promise.all([
    import("@/main/settings"),
    import("@/db"),
    import("@/db/schema"),
  ]);

  const gate: PrivacyGate = (projectId?: number) => {
    try {
      const s = readSettings();
      // Telemetry consent is an unconditional pre-requisite.
      if (s.telemetryConsent !== "opted_in") return false;
      // Per-project override wins both ways (true *and* false) when set.
      if (typeof projectId === "number") {
        const override =
          s.geniusCore?.keystrokeLoggerProjectOverrides?.[String(projectId)];
        if (typeof override === "boolean") return override;
      }
      return s.geniusCore?.keystrokeLoggerEnabled === true;
    } catch (err) {
      logger.warn("settings read failed in privacy gate", err);
      return false;
    }
  };

  const writer: EditLogWriter = async (entries) => {
    if (entries.length === 0) return;
    const db = getDb();
    await db.insert(editLogEntries).values(
      entries.map((e) => ({
        projectId: e.projectId,
        fileId: e.fileId,
        op: e.op,
        range: e.range,
        textHash: e.textHash,
        textLength: e.textLength,
        sequence: e.sequence,
        occurredAtMs: e.occurredAtMs,
      })),
    );
  };

  liveLogger = new EditLogger({
    gate,
    writer,
    publishDropped: (payload) => {
      // Best-effort: missing event-bus module must not block the editor
      // hot path. Resolved lazily so the import graph stays acyclic.
      void import("@/lib/events/domain_event_bus")
        .then(({ getDomainEventBus }) => {
          try {
            getDomainEventBus().publish(
              "genius_core.edit_log.dropped",
              payload,
            );
          } catch (err) {
            logger.warn("edit_log.dropped publish failed (ignored)", err);
          }
        })
        .catch((err) => {
          logger.warn(
            "domain_event_bus dynamic import failed (ignored)",
            err,
          );
        });
    },
  });
  return liveLogger;
}

// ── Export helper for Phase 6 distillation ───────────────────────────────

export interface ExportSessionOptions {
  projectId: number;
  sinceMs: number;
  limit?: number;
}

/**
 * Stream the captured edit log for a project window. Used by the Phase 6
 * distillation scheduler as the training input. Returns entries in
 * `(occurredAtMs, sequence)` order so causal sequence is preserved even
 * across clock skew.
 */
export async function exportSession(
  opts: ExportSessionOptions,
): Promise<EditLogEntry[]> {
  if (!Number.isInteger(opts.projectId) || opts.projectId <= 0) {
    throw new Error("exportSession: projectId must be a positive integer");
  }
  if (!Number.isFinite(opts.sinceMs) || opts.sinceMs < 0) {
    throw new Error("exportSession: sinceMs must be a non-negative number");
  }
  const limit = opts.limit ?? 10_000;
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error("exportSession: limit must be a positive integer");
  }

  const [{ getDb }, { editLogEntries }, { and, asc, eq, gte }] =
    await Promise.all([
      import("@/db"),
      import("@/db/schema"),
      import("drizzle-orm"),
    ]);

  const db = getDb();
  const rows = await db
    .select()
    .from(editLogEntries)
    .where(
      and(
        eq(editLogEntries.projectId, opts.projectId),
        gte(editLogEntries.occurredAtMs, opts.sinceMs),
      ),
    )
    .orderBy(asc(editLogEntries.occurredAtMs), asc(editLogEntries.sequence))
    .limit(limit);

  return rows.map((r) => ({
    projectId: r.projectId,
    fileId: r.fileId,
    op: r.op as EditOp,
    range: r.range,
    textHash: r.textHash,
    textLength: r.textLength,
    sequence: r.sequence,
    occurredAtMs: r.occurredAtMs,
  }));
}

/**
 * Group a freshly-flushed batch by projectId and best-effort mirror each
 * group's metadata (count, first/last seq, deterministic batch hash) to
 * the Hypercore peer layer. Entries themselves are NEVER mirrored.
 */
function mirrorFlushedBatch(batch: EditLogEntry[]): void {
  if (!batch || batch.length === 0) return;
  const byProject = new Map<number, EditLogEntry[]>();
  for (const e of batch) {
    const arr = byProject.get(e.projectId);
    if (arr) arr.push(e);
    else byProject.set(e.projectId, [e]);
  }
  for (const [projectId, entries] of byProject) {
    let firstSeq = entries[0].sequence;
    let lastSeq = firstSeq;
    let lastTs = entries[0].occurredAtMs;
    const hash = createHash("sha256");
    for (const e of entries) {
      if (e.sequence < firstSeq) firstSeq = e.sequence;
      if (e.sequence > lastSeq) lastSeq = e.sequence;
      if (e.occurredAtMs > lastTs) lastTs = e.occurredAtMs;
      hash.update(
        `${e.sequence}|${e.fileId}|${e.op}|${e.textHash ?? ""}|${e.textLength}`,
      );
    }
    mirrorGeniusCoreEvent(String(projectId), {
      type: "edits",
      projectId: String(projectId),
      batchHash: hash.digest("hex"),
      count: entries.length,
      firstSeq,
      lastSeq,
      ts: lastTs,
    });
  }
}
