/**
 * Genius Core — Continuous distillation scheduler (Phase 6).
 *
 * Pulls the most recent edit-log window for a project, hands it to a
 * pluggable trainer (default: thin wrapper around `localFineTuning`), and
 * emits {@link DomainEventMap}["genius_core.distillation.completed"] on
 * success. Optionally appends the resulting adapter as the next IPLD
 * context-slot delta for that project (Phase 4 integration).
 *
 * The scheduler itself is runtime-agnostic and fully unit-testable — every
 * environmental dependency (idle monitor, clock, edit-log exporter,
 * trainer, slot updater, event bus, settings gate) is injected. The
 * production wiring in {@link setupDistillationScheduler} binds those
 * seams to the live electron + db surfaces.
 */

import log from "electron-log";
import { createHash } from "crypto";
import type {
  DomainEventEnvelope,
  GeniusCoreAdapterRolledBackPayload,
  GeniusCoreDistillationCompletedPayload,
  GeniusCoreDistillationProgressPayload,
} from "@/lib/events/domain_event_bus";
import type { EditLogEntry } from "@/lib/genius_core/edit_logger";
import type { AdapterEvaluator } from "./adapter_evaluator";
import type { FederatedAggregator } from "./federated_aggregator";
import { mirrorGeniusCoreEvent } from "./hyper_bridge";

const logger = log.scope("distillation_scheduler");

/** Hex-encoded SHA-256 over the given bytes. */
function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// ── Public types ─────────────────────────────────────────────────────────

/** Manual / automatic origin of a distillation run. */
export type DistillationTriggerSource = "idle" | "manual";

/** Outcome of a single trainer invocation. */
export interface DistillationReceipt {
  /** Stable adapter identifier; trainer-defined (eg. uuid). */
  adapterId: string;
  /** Method used for training. v1 ships QLoRA on head layer only. */
  method: "lora" | "qlora";
  /** Number of edit-log entries that contributed to the training set. */
  sampleCount: number;
  /** Final training loss reported by the trainer. */
  finalLoss: number;
  /** Wall-clock training duration in milliseconds. */
  durationMs: number;
  /** Adapter binary bytes — fed to the context-slot manager when present. */
  adapterBytes?: Uint8Array;
  /** Base model id the adapter was trained against. */
  baseModelId: string;
  /**
   * Hex-encoded SHA-256 of `adapterBytes`. Optional on trainer output —
   * the scheduler computes it when missing and bytes are present so that
   * every published distill event is independently verifiable (DropEdition
   * mint + Celestia DA + peer aggregation all benefit). Empty string
   * means "adapter bytes unavailable, no hash produced".
   */
  adapterHash?: string;
}

/** Input handed to {@link DistillationTrainer.train}. */
export interface DistillationTrainerInput {
  projectId: number;
  baseModelId: string;
  /** Ordered, oldest-first edit log slice. */
  entries: EditLogEntry[];
  /** Closed window the entries were drawn from. */
  windowStartMs: number;
  windowEndMs: number;
  /** Caller may pin to a specific method; default is `qlora` for v1. */
  method?: "lora" | "qlora";
  /**
   * Optional streaming progress callback. Trainers SHOULD invoke this
   * for each training step they execute so subscribers can render a
   * live loss curve. Errors raised by the callback are swallowed by
   * the scheduler — trainers must not rely on it for correctness.
   */
  onProgress?: (progress: {
    step: number;
    totalSteps: number | null;
    loss: number | null;
  }) => void;
}

/** Pluggable trainer abstraction so unit tests do not need Python. */
export interface DistillationTrainer {
  train(input: DistillationTrainerInput): Promise<DistillationReceipt>;
}

/**
 * Idle-tick source. Default implementation wraps electron's
 * `powerMonitor`; tests inject a fake.
 */
export interface IdleMonitor {
  /**
   * Begin watching for "system became idle enough to train" signals.
   * `onTick` is invoked each time the criteria are met. The returned
   * disposer must stop the monitor without throwing.
   */
  start(onTick: () => void): () => void;
}

/** Read-only settings gate; checked on every tick. */
export type DistillationSettingsGate = () => boolean;

/** Listener for completed-run notifications (eg. domain event bus). */
export type DistillationCompletionPublisher = (
  payload: GeniusCoreDistillationCompletedPayload,
) => Promise<DomainEventEnvelope<"genius_core.distillation.completed"> | void> | void;

/**
 * Per-step training progress sink. Best-effort; errors are swallowed
 * upstream so a misbehaving subscriber never blocks the trainer.
 */
export type DistillationProgressPublisher = (
  payload: GeniusCoreDistillationProgressPayload,
) => void;

/**
 * Optional hook that fires whenever a successful run produces adapter
 * bytes — receives `(projectId, baseModelId, bytes)` and is expected to
 * persist the new context-slot delta. Default impl is wired against
 * `ContextSlotManager.updateSlot`.
 */
export type ContextSlotUpdater = (args: {
  projectId: string;
  baseModelId: string;
  adapterBytes: Uint8Array;
}) => Promise<{ cid: string } | void>;

/**
 * Optional auto-rollback hook — invoked when the evaluator flags a
 * regression after a fresh adapter was applied. Implementations should
 * revert the project's context-slot head to the previous CID and return
 * the resulting `{fromCid, toCid}` pair so the scheduler can audit-log
 * and mirror the event. Throwing aborts the rollback (the new adapter
 * stays live) but is logged.
 */
export type ContextSlotRollbackHandler = (args: {
  projectId: string;
}) => Promise<{ fromCid: string; toCid: string | null }>;

/** Publisher for adapter-rolled-back domain events. */
export type AdapterRolledBackPublisher = (
  payload: GeniusCoreAdapterRolledBackPayload,
) => Promise<DomainEventEnvelope<"genius_core.adapter.rolled_back"> | void> | void;

/** Source of "what's the current active project?" for the idle path. */
export type ActiveProjectResolver = () => Promise<number | null>;

export interface DistillationSchedulerOptions {
  trainer: DistillationTrainer;
  editLogExporter: (opts: {
    projectId: number;
    sinceMs: number;
    limit?: number;
  }) => Promise<EditLogEntry[]>;
  idleMonitor: IdleMonitor;
  settingsGate: DistillationSettingsGate;
  /** Resolves the "current" project for idle-driven runs. */
  activeProjectResolver: ActiveProjectResolver;
  /** Optional publisher of `genius_core.distillation.completed`. */
  publishCompletion?: DistillationCompletionPublisher;
  /** Optional per-step publisher of `genius_core.distillation.progress`. */
  publishProgress?: DistillationProgressPublisher;
  /** Optional hook to forward adapter bytes to context-slot manager. */
  updateContextSlot?: ContextSlotUpdater;
  /** Optional adapter-quality evaluator. When absent, no scoring runs. */
  evaluator?: AdapterEvaluator;
  /** Reverts the project's slot head one hop. Required only with evaluator. */
  rollbackHandler?: ContextSlotRollbackHandler;
  /** Publishes `genius_core.adapter.rolled_back` on regressions. */
  publishRollback?: AdapterRolledBackPublisher;
  /** Lazy supplier for the rollback threshold (kept reactive to settings). */
  rollbackThreshold?: () => number;
  /**
   * Minimum wall-clock interval (ms) between idle-driven runs. Manual
   * `runNow` invocations bypass this gate. Default: 30 minutes. Prevents
   * the scheduler from training back-to-back on a quiet machine when
   * edits trickle in just above `minSampleCount`.
   */
  minRunIntervalMs?: number;
  /**
   * Minimum loss improvement (against the last accepted adapter) before
   * a fresh adapter is promoted to the project's context slot. The
   * trainer still runs; on a sub-threshold delta the scheduler logs +
   * skips slot writes, evaluator, and federated aggregation. The local
   * completion event still fires so the UI can show "training ran but
   * did not improve quality". Default: 0.005 (0.5%). Set to 0 to
   * disable.
   */
  minLossImprovementDelta?: number;
  /**
   * Optional federated distillation aggregator. When supplied AND
   * `federatedAggregationGate()` returns true at the end of a successful
   * local run, the scheduler invokes `aggregator.run({projectId})` so
   * peer-contributed adapter weights can be merged into the local slot.
   * The call is fully best-effort: errors are logged and swallowed so a
   * P2P outage cannot break the local pipeline.
   */
  federatedAggregator?: FederatedAggregator;
  /** Read-only gate for the federated aggregator; checked per run. */
  federatedAggregationGate?: () => boolean;
  /** Source of monotonic time; overridable for tests. */
  clock?: () => number;
  /** Lookback window in milliseconds. Default: 24 hours. */
  windowMs?: number;
  /** Minimum samples required before the trainer is invoked. */
  minSampleCount?: number;
  /** Hard cap on entries pulled per run. */
  maxSampleCount?: number;
  /** Base model id passed to the trainer when settings don't override. */
  defaultBaseModelId: string;
}

/** Live status snapshot returned to renderers. */
export interface DistillationStatus {
  running: boolean;
  monitorActive: boolean;
  lastRun: {
    projectId: number;
    source: DistillationTriggerSource;
    startedAtMs: number;
    finishedAtMs: number;
    sampleCount: number;
    finalLoss: number;
    adapterId: string;
  } | null;
  lastError: { message: string; atMs: number } | null;
  /** Number of completed runs (success or failure). */
  runCount: number;
}

// ── Defaults ─────────────────────────────────────────────────────────────

const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h
const DEFAULT_MIN_SAMPLES = 16;
const DEFAULT_MAX_SAMPLES = 10_000;
const DEFAULT_MIN_RUN_INTERVAL_MS = 30 * 60 * 1000; // 30m
const DEFAULT_MIN_LOSS_DELTA = 0.005;

// ── Implementation ───────────────────────────────────────────────────────

/**
 * Indicates a manual `runNow` was rejected because a run is already in
 * flight. Surfaces through the IPC layer so the UI can show "busy".
 */
export class DistillationBusyError extends Error {
  constructor() {
    super("distillation already in progress");
    this.name = "DistillationBusyError";
  }
}

/**
 * Indicates a run was skipped because the active session does not have
 * enough captured samples (or the privacy gate is off).
 */
export class DistillationSkippedError extends Error {
  constructor(reason: string) {
    super(`distillation skipped: ${reason}`);
    this.name = "DistillationSkippedError";
  }
}

export class DistillationScheduler {
  private readonly opts: Required<
    Omit<
      DistillationSchedulerOptions,
      | "publishCompletion"
      | "publishProgress"
      | "updateContextSlot"
      | "evaluator"
      | "rollbackHandler"
      | "publishRollback"
      | "rollbackThreshold"
      | "federatedAggregator"
      | "federatedAggregationGate"
    >
  > & {
    publishCompletion?: DistillationCompletionPublisher;
    publishProgress?: DistillationProgressPublisher;
    updateContextSlot?: ContextSlotUpdater;
    evaluator?: AdapterEvaluator;
    rollbackHandler?: ContextSlotRollbackHandler;
    publishRollback?: AdapterRolledBackPublisher;
    rollbackThreshold?: () => number;
    federatedAggregator?: FederatedAggregator;
    federatedAggregationGate?: () => boolean;
  };
  private stopMonitor: (() => void) | null = null;
  private running = false;
  private lastRun: DistillationStatus["lastRun"] = null;
  private lastError: DistillationStatus["lastError"] = null;
  private runCount = 0;
  /**
   * Last final loss whose adapter was actually promoted to the slot.
   * Used by the min-loss-delta gate to suppress no-improvement
   * promotions. `null` means "no prior accepted adapter" — first run
   * always passes the gate.
   */
  private lastAcceptedFinalLoss: number | null = null;

  constructor(opts: DistillationSchedulerOptions) {
    if (!opts.trainer) {
      throw new Error("DistillationScheduler requires a trainer");
    }
    if (!opts.editLogExporter) {
      throw new Error("DistillationScheduler requires an editLogExporter");
    }
    if (!opts.idleMonitor) {
      throw new Error("DistillationScheduler requires an idleMonitor");
    }
    if (!opts.settingsGate) {
      throw new Error("DistillationScheduler requires a settingsGate");
    }
    if (!opts.activeProjectResolver) {
      throw new Error("DistillationScheduler requires an activeProjectResolver");
    }
    if (
      typeof opts.defaultBaseModelId !== "string" ||
      opts.defaultBaseModelId.length === 0
    ) {
      throw new Error("DistillationScheduler requires defaultBaseModelId");
    }
    const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
    const minSampleCount = opts.minSampleCount ?? DEFAULT_MIN_SAMPLES;
    const maxSampleCount = opts.maxSampleCount ?? DEFAULT_MAX_SAMPLES;
    const minRunIntervalMs =
      opts.minRunIntervalMs ?? DEFAULT_MIN_RUN_INTERVAL_MS;
    const minLossImprovementDelta =
      opts.minLossImprovementDelta ?? DEFAULT_MIN_LOSS_DELTA;
    if (!Number.isFinite(windowMs) || windowMs <= 0) {
      throw new Error("DistillationScheduler: windowMs must be positive");
    }
    if (!Number.isInteger(minSampleCount) || minSampleCount <= 0) {
      throw new Error("DistillationScheduler: minSampleCount must be > 0");
    }
    if (
      !Number.isInteger(maxSampleCount) ||
      maxSampleCount < minSampleCount
    ) {
      throw new Error(
        "DistillationScheduler: maxSampleCount must be ≥ minSampleCount",
      );
    }
    if (!Number.isFinite(minRunIntervalMs) || minRunIntervalMs < 0) {
      throw new Error(
        "DistillationScheduler: minRunIntervalMs must be ≥ 0",
      );
    }
    if (
      !Number.isFinite(minLossImprovementDelta) ||
      minLossImprovementDelta < 0
    ) {
      throw new Error(
        "DistillationScheduler: minLossImprovementDelta must be ≥ 0",
      );
    }
    this.opts = {
      trainer: opts.trainer,
      editLogExporter: opts.editLogExporter,
      idleMonitor: opts.idleMonitor,
      settingsGate: opts.settingsGate,
      activeProjectResolver: opts.activeProjectResolver,
      publishCompletion: opts.publishCompletion,
      publishProgress: opts.publishProgress,
      updateContextSlot: opts.updateContextSlot,
      evaluator: opts.evaluator,
      rollbackHandler: opts.rollbackHandler,
      publishRollback: opts.publishRollback,
      rollbackThreshold: opts.rollbackThreshold,
      federatedAggregator: opts.federatedAggregator,
      federatedAggregationGate: opts.federatedAggregationGate,
      clock: opts.clock ?? Date.now,
      windowMs,
      minSampleCount,
      maxSampleCount,
      minRunIntervalMs,
      minLossImprovementDelta,
      defaultBaseModelId: opts.defaultBaseModelId,
    };
  }

  /** Begin idle monitoring. Idempotent. */
  start(): void {
    if (this.stopMonitor) return;
    if (!this.opts.settingsGate()) {
      logger.debug("scheduler start skipped: settings gate is off");
      return;
    }
    this.stopMonitor = this.opts.idleMonitor.start(() => {
      void this.handleIdleTick();
    });
    logger.info("distillation scheduler started");
  }

  /** Stop idle monitoring. Idempotent. */
  stop(): void {
    if (!this.stopMonitor) return;
    try {
      this.stopMonitor();
    } catch (err) {
      logger.warn("idle monitor disposer threw (ignored)", err);
    }
    this.stopMonitor = null;
    logger.info("distillation scheduler stopped");
  }

  /** Snapshot suitable for renderer status display. */
  getStatus(): DistillationStatus {
    return {
      running: this.running,
      monitorActive: this.stopMonitor !== null,
      lastRun: this.lastRun,
      lastError: this.lastError,
      runCount: this.runCount,
    };
  }

  /**
   * Trigger a run immediately for `projectId`. Bypasses the settings
   * gate (manual = explicit intent) but still respects the
   * single-flight lock and the minimum-sample threshold.
   */
  async runNow(projectId: number): Promise<DistillationReceipt> {
    if (!Number.isInteger(projectId) || projectId <= 0) {
      throw new Error("runNow: projectId must be a positive integer");
    }
    return this.runOnce(projectId, "manual");
  }

  /**
   * Called by the idle monitor. Quietly no-ops when conditions aren't
   * met — never throws into the monitor tick.
   */
  private async handleIdleTick(): Promise<void> {
    try {
      if (this.running) return;
      if (!this.opts.settingsGate()) return;
      // Cooldown gate — prevents the trainer from being re-invoked too
      // soon after a previous run on a chatty machine. Manual runs
      // bypass this gate (see runNow).
      if (
        this.opts.minRunIntervalMs > 0 &&
        this.lastRun &&
        this.opts.clock() - this.lastRun.finishedAtMs <
          this.opts.minRunIntervalMs
      ) {
        logger.debug("idle tick skipped: cooldown active", {
          sinceLastMs: this.opts.clock() - this.lastRun.finishedAtMs,
          minRunIntervalMs: this.opts.minRunIntervalMs,
        });
        return;
      }
      const projectId = await this.opts.activeProjectResolver();
      if (projectId == null) return;
      if (!Number.isInteger(projectId) || projectId <= 0) return;
      await this.runOnce(projectId, "idle");
    } catch (err) {
      // Idle-driven failures are logged but never propagated; manual
      // runs surface errors to the caller via runNow.
      if (err instanceof DistillationSkippedError) {
        logger.debug("idle tick skipped", { reason: err.message });
        return;
      }
      logger.warn("idle distillation run failed", err);
    }
  }

  private async runOnce(
    projectId: number,
    source: DistillationTriggerSource,
  ): Promise<DistillationReceipt> {
    if (this.running) {
      throw new DistillationBusyError();
    }
    this.running = true;
    const startedAtMs = this.opts.clock();
    try {
      const sinceMs = Math.max(0, startedAtMs - this.opts.windowMs);
      const entries = await this.opts.editLogExporter({
        projectId,
        sinceMs,
        limit: this.opts.maxSampleCount,
      });
      if (entries.length < this.opts.minSampleCount) {
        throw new DistillationSkippedError(
          `only ${entries.length} samples (min ${this.opts.minSampleCount})`,
        );
      }
      const receipt = await this.opts.trainer.train({
        projectId,
        baseModelId: this.opts.defaultBaseModelId,
        entries,
        windowStartMs: sinceMs,
        windowEndMs: startedAtMs,
        method: "qlora",
        onProgress: (progress) => {
          const publish = this.opts.publishProgress;
          if (!publish) return;
          try {
            publish({
              projectId: String(projectId),
              runId: `${projectId}-${startedAtMs}`,
              step: progress.step,
              totalSteps: progress.totalSteps ?? null,
              loss: progress.loss ?? null,
              atMs: this.opts.clock(),
            });
          } catch (err) {
            logger.warn(
              "publishProgress threw; swallowed to protect trainer hot path",
              err,
            );
          }
        },
      });
      if (
        !receipt ||
        typeof receipt.adapterId !== "string" ||
        receipt.adapterId.length === 0
      ) {
        throw new Error("trainer returned invalid receipt: missing adapterId");
      }

      // Compute / verify integrity hash for the adapter bytes so that
      // every downstream consumer (slot writer, completion event,
      // hyper-bridge distill event, federated aggregator) sees the same
      // tamper-evident fingerprint. Trainers MAY pre-populate
      // `adapterHash`; if they do we trust it (avoids re-hashing huge
      // tensors) but still backfill it when missing + bytes are present.
      const adapterHash =
        receipt.adapterHash && receipt.adapterHash.length > 0
          ? receipt.adapterHash
          : receipt.adapterBytes
            ? sha256Hex(receipt.adapterBytes)
            : "";

      const finishedAtMs = this.opts.clock();
      this.lastRun = {
        projectId,
        source,
        startedAtMs,
        finishedAtMs,
        sampleCount: receipt.sampleCount,
        finalLoss: receipt.finalLoss,
        adapterId: receipt.adapterId,
      };
      this.lastError = null;
      this.runCount += 1;

      // Min-loss-delta gate — if the trainer ran but the new adapter
      // is not measurably better than the last accepted one, treat the
      // receipt as informational only: skip slot promotion, skip
      // evaluator + rollback, and skip federated aggregation. The
      // completion event still fires so the UI can show "training ran
      // but did not improve quality". `lastAcceptedFinalLoss` is left
      // unchanged so subsequent runs still compare against the last
      // *promoted* loss — not a regression intermediate.
      const acceptForPromotion =
        this.opts.minLossImprovementDelta <= 0 ||
        this.lastAcceptedFinalLoss === null ||
        receipt.finalLoss <=
          this.lastAcceptedFinalLoss - this.opts.minLossImprovementDelta;
      if (!acceptForPromotion) {
        logger.info("adapter not promoted: loss improvement below delta", {
          projectId,
          finalLoss: receipt.finalLoss,
          lastAcceptedFinalLoss: this.lastAcceptedFinalLoss,
          minLossImprovementDelta: this.opts.minLossImprovementDelta,
        });
      }

      // Fan-out: context slot append (best-effort) then domain event.
      let newSlotCid: string | null = null;
      if (
        acceptForPromotion &&
        this.opts.updateContextSlot &&
        receipt.adapterBytes
      ) {
        try {
          const slotResult = await this.opts.updateContextSlot({
            projectId: String(projectId),
            baseModelId: receipt.baseModelId,
            adapterBytes: receipt.adapterBytes,
          });
          if (slotResult && typeof slotResult.cid === "string") {
            newSlotCid = slotResult.cid;
          }
        } catch (err) {
          // A slot-write failure must not invalidate the training
          // receipt — the adapter file is already on disk.
          logger.warn("context slot update failed (ignored)", err);
        }
      }

      // Quality scoring + auto-rollback (best-effort).
      if (acceptForPromotion && this.opts.evaluator) {
        try {
          const threshold = this.opts.rollbackThreshold
            ? this.opts.rollbackThreshold()
            : 0;
          const evalResult = await this.opts.evaluator.evaluate({
            projectId,
            adapterId: receipt.adapterId,
            slotCid: newSlotCid,
            rollbackThreshold: threshold,
          });
          if (
            evalResult &&
            evalResult.regression &&
            evalResult.baselineScore !== null &&
            this.opts.rollbackHandler
          ) {
            try {
              const rollback = await this.opts.rollbackHandler({
                projectId: String(projectId),
              });
              const payload: GeniusCoreAdapterRolledBackPayload = {
                projectId: String(projectId),
                adapterId: receipt.adapterId,
                score: evalResult.score,
                baselineScore: evalResult.baselineScore,
                revertedToCid: rollback.toCid,
              };
              if (this.opts.publishRollback) {
                try {
                  await this.opts.publishRollback(payload);
                } catch (publishErr) {
                  logger.warn(
                    "rollback event publish failed (ignored)",
                    publishErr,
                  );
                }
              }
              mirrorGeniusCoreEvent(String(projectId), {
                type: "rollback",
                projectId: String(projectId),
                adapterId: receipt.adapterId,
                revertedToCid: rollback.toCid,
                score: evalResult.score,
                baselineScore: evalResult.baselineScore,
                ts: this.opts.clock(),
              });
              logger.warn("adapter auto-rolled-back due to regression", {
                projectId,
                adapterId: receipt.adapterId,
                score: evalResult.score,
                baseline: evalResult.baselineScore,
              });
            } catch (rollbackErr) {
              logger.warn(
                "adapter rollback failed (regression flagged but slot not reverted)",
                rollbackErr,
              );
            }
          }
        } catch (err) {
          logger.warn("adapter evaluation failed (ignored)", err);
        }
      }

      if (this.opts.publishCompletion) {
        try {
          await this.opts.publishCompletion({
            projectId: String(projectId),
            adapterId: receipt.adapterId,
            method: receipt.method,
            sampleCount: receipt.sampleCount,
            finalLoss: receipt.finalLoss,
            durationMs: receipt.durationMs,
            adapterHash,
          });
        } catch (err) {
          logger.warn("distillation event publish failed (ignored)", err);
        }
      }

      logger.info("distillation run complete", {
        projectId,
        source,
        adapterId: receipt.adapterId,
        sampleCount: receipt.sampleCount,
        finalLoss: receipt.finalLoss,
        promoted: acceptForPromotion,
      });
      if (acceptForPromotion) {
        this.lastAcceptedFinalLoss = receipt.finalLoss;
        mirrorGeniusCoreEvent(String(projectId), {
        type: "distill",
        projectId: String(projectId),
        adapterId: receipt.adapterId,
        method: receipt.method,
        sampleCount: receipt.sampleCount,
        finalLoss: receipt.finalLoss,
        durationMs: receipt.durationMs,
        baseModelId: receipt.baseModelId,
        adapterHash,
        ts: finishedAtMs,
      });
      }

      // Federated distillation aggregation (best-effort, opt-in).
      // Runs *after* the local distill receipt is published so peers see
      // our contribution before we attempt to pull theirs in. The gate
      // call is wrapped so a missing/throwing setting never blocks the
      // local pipeline. Skipped entirely when the adapter was not
      // promoted (no point pulling peers in on top of a no-op).
      if (acceptForPromotion && this.opts.federatedAggregator) {
        const gateOk = (() => {
          try {
            return this.opts.federatedAggregationGate
              ? this.opts.federatedAggregationGate() === true
              : false;
          } catch (err) {
            logger.warn("federated aggregation gate threw (treating as off)", err);
            return false;
          }
        })();
        if (gateOk) {
          try {
            await this.opts.federatedAggregator.run({
              projectId: String(projectId),
            });
          } catch (err) {
            logger.warn("federated aggregation failed (ignored)", err);
          }
        }
      }

      return receipt;
    } catch (err) {
      this.runCount += 1;
      const message = err instanceof Error ? err.message : String(err);
      this.lastError = { message, atMs: this.opts.clock() };
      throw err;
    } finally {
      this.running = false;
    }
  }
}

// ── Production singleton wiring ──────────────────────────────────────────

let liveScheduler: DistillationScheduler | null = null;

export function getDistillationScheduler(): DistillationScheduler {
  if (!liveScheduler) {
    throw new Error("Genius Core distillation scheduler not initialised");
  }
  return liveScheduler;
}

export function __resetDistillationSchedulerForTests(): void {
  if (liveScheduler) {
    try {
      liveScheduler.stop();
    } catch {
      // ignore
    }
  }
  liveScheduler = null;
}

/**
 * Wraps electron's `powerMonitor` with the brief's "idle ≥ 10 min, AC
 * powered" criteria. Polls every 60s. Battery threshold is checked when
 * the API is available — silently skipped on platforms without it.
 */
function createPowerMonitorIdleMonitor(opts: {
  idleThresholdSec?: number;
  pollIntervalMs?: number;
}): IdleMonitor {
  const idleThresholdSec = opts.idleThresholdSec ?? 10 * 60; // 10 min
  const pollIntervalMs = opts.pollIntervalMs ?? 60_000;
  return {
    start(onTick) {
      // Lazy import: electron is unavailable in unit-test environments.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const electron = require("electron") as typeof import("electron");
      const { powerMonitor } = electron;
      let stopped = false;
      const tick = () => {
        if (stopped) return;
        try {
          const idleFor =
            typeof powerMonitor.getSystemIdleTime === "function"
              ? powerMonitor.getSystemIdleTime()
              : 0;
          if (idleFor < idleThresholdSec) return;
          // AC-powered gate: getCurrentThermalState / onBatteryPower
          // aren't universally available — best-effort guard.
          const onBattery =
            typeof (
              powerMonitor as unknown as { onBatteryPower?: boolean }
            ).onBatteryPower === "boolean"
              ? (powerMonitor as unknown as { onBatteryPower: boolean })
                  .onBatteryPower
              : false;
          if (onBattery) return;
          onTick();
        } catch (err) {
          logger.warn("powerMonitor tick failed", err);
        }
      };
      const handle = setInterval(tick, pollIntervalMs);
      return () => {
        stopped = true;
        clearInterval(handle);
      };
    },
  };
}

/**
 * Default trainer: no-op that throws unless wired. Production wiring
 * (Phase 6.x will swap this in) binds to `localFineTuning`. We keep the
 * scheduler usable in dev with the explicit stub so misconfiguration
 * surfaces as a clear error rather than silently no-oping.
 */
class UnwiredTrainer implements DistillationTrainer {
  async train(): Promise<DistillationReceipt> {
    throw new Error(
      "Genius Core distillation trainer is not wired — set up via setupDistillationScheduler({ trainer })",
    );
  }
}

export interface SetupDistillationSchedulerOptions {
  trainer?: DistillationTrainer;
  activeProjectResolver?: ActiveProjectResolver;
  windowMs?: number;
  minSampleCount?: number;
  /** Override the default `geniusCore.baseModelId` source. */
  defaultBaseModelId?: string;
}

/**
 * Lazy initialiser. Wires the scheduler against the live edit logger,
 * power monitor, settings, event bus and context-slot manager. The
 * trainer must be supplied (production binding lands when Phase 6.4
 * routes through `localFineTuning`).
 */
export async function setupDistillationScheduler(
  opts: SetupDistillationSchedulerOptions = {},
): Promise<DistillationScheduler> {
  if (liveScheduler) return liveScheduler;

  const [
    { exportSession },
    { readSettings },
    { getDomainEventBus },
    contextSlotModule,
    { setupAdapterEvaluator },
  ] = await Promise.all([
    import("@/lib/genius_core/edit_logger"),
    import("@/main/settings"),
    import("@/lib/events/domain_event_bus"),
    import("@/lib/genius_core/context_slots"),
    import("@/lib/genius_core/adapter_evaluator"),
  ]);

  const settingsGate: DistillationSettingsGate = () => {
    try {
      const s = readSettings();
      return s.geniusCore?.nightlyDistillationEnabled === true;
    } catch (err) {
      logger.warn("settings read failed in distillation gate", err);
      return false;
    }
  };

  const defaultBaseModelId =
    opts.defaultBaseModelId ??
    (() => {
      try {
        return readSettings().geniusCore?.baseModelId ?? "phi-3-mini-4k-int4";
      } catch {
        return "phi-3-mini-4k-int4";
      }
    })();

  const updateContextSlot: ContextSlotUpdater = async ({
    projectId,
    baseModelId,
    adapterBytes,
  }) => {
    let mgr;
    try {
      mgr = contextSlotModule.getContextSlotManager();
    } catch {
      mgr = await contextSlotModule.setupContextSlotManager();
    }
    const peek = await mgr.loadSlot(projectId);
    const result = peek
      ? await mgr.updateSlot({ projectId, baseModelId, adapterBytes })
      : await mgr.createSlot({ projectId, baseModelId, adapterBytes });

    // Best-effort history pruning after a real update (skip on first
    // creation — nothing to prune). Reads `slotHistoryKeepLast` from
    // settings each call so user changes take effect immediately.
    if (peek) {
      try {
        const keepLastSetting = readSettings().geniusCore?.slotHistoryKeepLast;
        const keepLast =
          typeof keepLastSetting === "number" && Number.isFinite(keepLastSetting)
            ? keepLastSetting
            : 10;
        if (keepLast > 0) {
          await mgr.pruneHistory(projectId, { keepLast });
        }
      } catch (err) {
        logger.warn(
          "post-update slot history prune failed (ignored)",
          err instanceof Error ? err.message : err,
        );
      }
    }
    return { cid: result.cid };
  };

  const rollbackHandler: ContextSlotRollbackHandler = async ({ projectId }) => {
    let mgr;
    try {
      mgr = contextSlotModule.getContextSlotManager();
    } catch {
      mgr = await contextSlotModule.setupContextSlotManager();
    }
    return mgr.rollbackSlot(projectId);
  };

  const bus = getDomainEventBus();
  const publishCompletion: DistillationCompletionPublisher = (payload) =>
    bus.publish("genius_core.distillation.completed", payload);
  const publishProgress: DistillationProgressPublisher = (payload) => {
    try {
      void bus.publish("genius_core.distillation.progress", payload);
    } catch (err) {
      logger.warn("distillation.progress publish failed (ignored)", err);
    }
  };
  const publishRollback: AdapterRolledBackPublisher = (payload) =>
    bus.publish("genius_core.adapter.rolled_back", payload);

  const evaluator = await setupAdapterEvaluator().catch((err) => {
    logger.warn("adapter evaluator setup failed (quality scoring disabled)", err);
    return undefined;
  });

  const rollbackThreshold = () => {
    try {
      const v = readSettings().geniusCore?.adapterRollbackThreshold;
      return typeof v === "number" && Number.isFinite(v) ? v : 0;
    } catch {
      return 0;
    }
  };

  const activeProjectResolver: ActiveProjectResolver =
    opts.activeProjectResolver ?? (async () => null);

  // Federated aggregation: gated by setting AND availability of a real
  // aggregator instance. The production aggregator factory currently
  // returns `undefined` until the Phase 9 peer/IPFS deps land — at which
  // point swapping the factory wires aggregation on without scheduler
  // changes.
  const federatedAggregationGate = () => {
    try {
      return (
        readSettings().geniusCore?.federatedDistillationEnabled === true
      );
    } catch {
      return false;
    }
  };
  let federatedAggregator: FederatedAggregator | undefined;
  try {
    const mod = await import("./federated_aggregator_setup");
    federatedAggregator = await mod.setupFederatedAggregator();
  } catch (err) {
    logger.debug(
      "federated aggregator setup unavailable (phase 9 wiring pending)",
      err instanceof Error ? err.message : err,
    );
  }

  liveScheduler = new DistillationScheduler({
    trainer: opts.trainer ?? new UnwiredTrainer(),
    editLogExporter: exportSession,
    idleMonitor: createPowerMonitorIdleMonitor({}),
    settingsGate,
    activeProjectResolver,
    publishCompletion,
    publishProgress,
    updateContextSlot,
    evaluator: evaluator ?? undefined,
    rollbackHandler,
    publishRollback,
    rollbackThreshold,
    federatedAggregator,
    federatedAggregationGate,
    defaultBaseModelId,
    windowMs: opts.windowMs,
    minSampleCount: opts.minSampleCount,
  });
  return liveScheduler;
}
