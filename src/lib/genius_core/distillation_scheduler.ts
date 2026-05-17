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
import type {
  DomainEventEnvelope,
  GeniusCoreDistillationCompletedPayload,
} from "@/lib/events/domain_event_bus";
import type { EditLogEntry } from "@/lib/genius_core/edit_logger";

const logger = log.scope("distillation_scheduler");

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
 * Optional hook that fires whenever a successful run produces adapter
 * bytes — receives `(projectId, baseModelId, bytes)` and is expected to
 * persist the new context-slot delta. Default impl is wired against
 * `ContextSlotManager.updateSlot`.
 */
export type ContextSlotUpdater = (args: {
  projectId: string;
  baseModelId: string;
  adapterBytes: Uint8Array;
}) => Promise<void>;

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
  /** Optional hook to forward adapter bytes to context-slot manager. */
  updateContextSlot?: ContextSlotUpdater;
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
    Omit<DistillationSchedulerOptions, "publishCompletion" | "updateContextSlot">
  > & {
    publishCompletion?: DistillationCompletionPublisher;
    updateContextSlot?: ContextSlotUpdater;
  };
  private stopMonitor: (() => void) | null = null;
  private running = false;
  private lastRun: DistillationStatus["lastRun"] = null;
  private lastError: DistillationStatus["lastError"] = null;
  private runCount = 0;

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
    this.opts = {
      trainer: opts.trainer,
      editLogExporter: opts.editLogExporter,
      idleMonitor: opts.idleMonitor,
      settingsGate: opts.settingsGate,
      activeProjectResolver: opts.activeProjectResolver,
      publishCompletion: opts.publishCompletion,
      updateContextSlot: opts.updateContextSlot,
      clock: opts.clock ?? Date.now,
      windowMs,
      minSampleCount,
      maxSampleCount,
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
      });
      if (
        !receipt ||
        typeof receipt.adapterId !== "string" ||
        receipt.adapterId.length === 0
      ) {
        throw new Error("trainer returned invalid receipt: missing adapterId");
      }

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

      // Fan-out: context slot append (best-effort) then domain event.
      if (this.opts.updateContextSlot && receipt.adapterBytes) {
        try {
          await this.opts.updateContextSlot({
            projectId: String(projectId),
            baseModelId: receipt.baseModelId,
            adapterBytes: receipt.adapterBytes,
          });
        } catch (err) {
          // A slot-write failure must not invalidate the training
          // receipt — the adapter file is already on disk.
          logger.warn("context slot update failed (ignored)", err);
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
      });
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
  ] = await Promise.all([
    import("@/lib/genius_core/edit_logger"),
    import("@/main/settings"),
    import("@/lib/events/domain_event_bus"),
    import("@/lib/genius_core/context_slots"),
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
    if (peek) {
      await mgr.updateSlot({ projectId, baseModelId, adapterBytes });
    } else {
      await mgr.createSlot({ projectId, baseModelId, adapterBytes });
    }
  };

  const bus = getDomainEventBus();
  const publishCompletion: DistillationCompletionPublisher = (payload) =>
    bus.publish("genius_core.distillation.completed", payload);

  const activeProjectResolver: ActiveProjectResolver =
    opts.activeProjectResolver ?? (async () => null);

  liveScheduler = new DistillationScheduler({
    trainer: opts.trainer ?? new UnwiredTrainer(),
    editLogExporter: exportSession,
    idleMonitor: createPowerMonitorIdleMonitor({}),
    settingsGate,
    activeProjectResolver,
    publishCompletion,
    updateContextSlot,
    defaultBaseModelId,
    windowMs: opts.windowMs,
    minSampleCount: opts.minSampleCount,
  });
  return liveScheduler;
}
