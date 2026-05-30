/**
 * Genius Core IPC handlers.
 *
 * Renderer-facing surface for the local ONNX runtime facade in
 * `src/lib/genius_core/`. All handlers throw on failure per the project's
 * IPC convention — callers should wrap in TanStack Query / Mutation and
 * surface errors via the standard toast helpers.
 *
 * The seven channels exposed here form the stable contract that Phases 1+
 * fulfil by swapping the backend in {@link GeniusCore.setBackend}; the
 * channel shapes do not change as concrete subsystems land.
 */

import { app, ipcMain } from "electron";
import { BrowserWindow } from "electron";
import log from "electron-log";

import { getDomainEventBus } from "@/lib/events/domain_event_bus";

import {
  GeniusCore,
  type GeniusCoreInferRequest,
  type GeniusCoreInferResponse,
  type GeniusCoreStatusReport,
} from "@/lib/genius_core";
import {
  GENIUS_CORE_BASE_MODELS,
  findBaseModel,
} from "@/lib/genius_core/model_format";
import {
  getContextSlotManager,
  setupContextSlotManager,
} from "@/lib/genius_core/context_slots";
import {
  exportSession as exportEditSession,
  getEditLogger,
  setupEditLogger,
  type EditLogEntry,
  type EditOp,
  type EditRange,
  type RecordInput,
} from "@/lib/genius_core/edit_logger";
import {
  getDistillationScheduler,
  setupDistillationScheduler,
  type DistillationReceipt,
  type DistillationStatus,
} from "@/lib/genius_core/distillation_scheduler";
import { createLocalDistillationTrainer } from "@/lib/genius_core/local_distillation_trainer";
import {
  getAdapterEvaluator,
  setupAdapterEvaluator,
  type AdapterScoreRow,
  type EvalSet,
} from "@/lib/genius_core/adapter_evaluator";
import { readSettings, writeSettings } from "@/main/settings";
import { getGeniusCoreSettings } from "@/main/settings";
import type { UserSettings } from "@/lib/schemas";

const logger = log.scope("genius_core_handlers");

/**
 * Spread the prior `geniusCore` settings block before applying `updates`.
 * Fixes a class of bugs where individual writeSettings call-sites built
 * the object from scratch and silently dropped newer optional fields
 * (eg. `hyperReplicationEnabled`, `adapterRollbackThreshold`).
 */
function patchGeniusCoreSettings(
  updates: Partial<NonNullable<UserSettings["geniusCore"]>>,
): void {
  const current = readSettings();
  const prior = current.geniusCore;
  writeSettings({
    geniusCore: {
      enabled: prior?.enabled ?? false,
      vramBudgetGb: prior?.vramBudgetGb ?? 8,
      baseModelId: prior?.baseModelId ?? "phi-3-mini-4k-int4",
      executionProvider: prior?.executionProvider ?? "auto",
      contextSlotsDir: prior?.contextSlotsDir,
      npuOffloadEnabled: prior?.npuOffloadEnabled ?? false,
      weightStreamingEnabled: prior?.weightStreamingEnabled ?? false,
      keystrokeLoggerEnabled: prior?.keystrokeLoggerEnabled ?? false,
      nightlyDistillationEnabled: prior?.nightlyDistillationEnabled ?? false,
      hyperReplicationEnabled: prior?.hyperReplicationEnabled ?? false,
      adapterRollbackThreshold: prior?.adapterRollbackThreshold ?? 0.05,
      federatedDistillationEnabled:
        prior?.federatedDistillationEnabled ?? false,
      slotHistoryKeepLast: prior?.slotHistoryKeepLast,
      keystrokeLoggerProjectOverrides:
        prior?.keystrokeLoggerProjectOverrides,
      toolCallFallback: prior?.toolCallFallback,
      ...updates,
    },
  });
}

/** Pure validator extracted so unit tests can exercise the branches. */
export function assertInferRequest(value: unknown): GeniusCoreInferRequest {
  if (!value || typeof value !== "object") {
    throw new Error("genius-core:infer expected a request object");
  }
  const v = value as Record<string, unknown>;
  if (typeof v.prompt !== "string" || v.prompt.length === 0) {
    throw new Error("genius-core:infer requires a non-empty `prompt` string");
  }
  if (v.maxTokens !== undefined && (typeof v.maxTokens !== "number" || v.maxTokens <= 0)) {
    throw new Error("genius-core:infer `maxTokens` must be a positive number");
  }
  if (
    v.temperature !== undefined &&
    (typeof v.temperature !== "number" || v.temperature < 0)
  ) {
    throw new Error("genius-core:infer `temperature` must be a non-negative number");
  }
  return {
    prompt: v.prompt,
    projectId: typeof v.projectId === "string" ? v.projectId : undefined,
    maxTokens: typeof v.maxTokens === "number" ? v.maxTokens : undefined,
    temperature: typeof v.temperature === "number" ? v.temperature : undefined,
  };
}

/**
 * Public shape returned by `genius-core:list-base-models`. Pulled from the
 * curated catalogue in `model_format.ts` and stable across phases.
 */
export interface GeniusCoreBaseModelListEntry {
  id: string;
  displayName: string;
  format: "onnx";
  quantization: string;
  contextWindow: number;
  executionProviders: string[];
  approxBytes: number;
  source: "curated" | "registry";
}

export function listBaseModels(): GeniusCoreBaseModelListEntry[] {
  return GENIUS_CORE_BASE_MODELS.map((m) => ({
    id: m.id,
    displayName: m.displayName,
    format: "onnx",
    quantization: m.quantization,
    contextWindow: m.contextWindow,
    executionProviders: m.supportedProviders.map(String),
    approxBytes: m.approxBytes,
    source: m.source,
  }));
}

/** Stable, renderer-facing shape of a project context slot. */
export interface GeniusCoreProjectSlotInfo {
  projectId: string;
  cid: string | null;
  baseModelId: string | null;
  /** Byte length of the wrapped adapter payload; 0 when slot is absent. */
  adapterBytes: number;
  /** Epoch milliseconds when the slot was minted; 0 when slot is absent. */
  createdAtMs: number;
  /** Prior slot CID for DAG history; null on root or absent slot. */
  previousCid: string | null;
}

function projectIdGuard(value: unknown, channel: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${channel} requires a non-empty projectId string`);
  }
  return value;
}

/**
 * Return the live context slot manager, lazily wiring it on first call.
 * Keeps the renderer-facing IPC channels usable without a separate
 * bootstrap step from main.
 */
async function ensureSlotManager() {
  try {
    return getContextSlotManager();
  } catch {
    return setupContextSlotManager();
  }
}

function emptySlotInfo(projectId: string): GeniusCoreProjectSlotInfo {
  return {
    projectId,
    cid: null,
    baseModelId: null,
    adapterBytes: 0,
    createdAtMs: 0,
    previousCid: null,
  };
}

/** Lazy edit-logger access mirroring `ensureSlotManager`. */
async function ensureEditLogger() {
  try {
    return getEditLogger();
  } catch {
    return setupEditLogger();
  }
}

/**
 * Tracks the project (== appId) the user most recently edited. Updated by the
 * `genius-core:record-edit` handler and consumed by the distillation
 * scheduler's idle path as the "active project" to distil.
 */
let lastEditProjectId: number | null = null;

/**
 * Resolve the active project for idle distillation. Prefers the most
 * recently edited project; the scheduler skips the run when this is null.
 */
const resolveActiveProject = async (): Promise<number | null> => {
  if (
    typeof lastEditProjectId === "number" &&
    Number.isInteger(lastEditProjectId) &&
    lastEditProjectId > 0
  ) {
    return lastEditProjectId;
  }
  return null;
};

/** Lazy distillation-scheduler access mirroring `ensureSlotManager`. */
async function ensureDistillationScheduler() {
  try {
    return getDistillationScheduler();
  } catch {
    return setupDistillationScheduler({
      trainer: createLocalDistillationTrainer(),
      activeProjectResolver: resolveActiveProject,
    });
  }
}

/** Lazy adapter-evaluator access mirroring the other ensure* helpers. */
async function ensureAdapterEvaluator() {
  try {
    return getAdapterEvaluator();
  } catch {
    return setupAdapterEvaluator();
  }
}

/** Renderer-facing serialisable receipt (strips Uint8Array). */
export interface GeniusCoreDistillationReceiptDto {
  adapterId: string;
  method: "lora" | "qlora";
  sampleCount: number;
  finalLoss: number;
  durationMs: number;
  baseModelId: string;
  adapterByteLength: number;
}

function toReceiptDto(
  r: DistillationReceipt,
): GeniusCoreDistillationReceiptDto {
  return {
    adapterId: r.adapterId,
    method: r.method,
    sampleCount: r.sampleCount,
    finalLoss: r.finalLoss,
    durationMs: r.durationMs,
    baseModelId: r.baseModelId,
    adapterByteLength: r.adapterBytes?.byteLength ?? 0,
  };
}

/** Validator for the `genius-core:record-edit` payload. */
export function assertRecordEditInput(value: unknown): RecordInput {
  if (!value || typeof value !== "object") {
    throw new Error("genius-core:record-edit expected an input object");
  }
  const v = value as Record<string, unknown>;
  if (!Number.isInteger(v.projectId) || (v.projectId as number) <= 0) {
    throw new Error(
      "genius-core:record-edit requires `projectId` as a positive integer",
    );
  }
  if (typeof v.fileId !== "string" || v.fileId.length === 0) {
    throw new Error(
      "genius-core:record-edit requires `fileId` as a non-empty string",
    );
  }
  const op = v.op;
  const validOps: ReadonlyArray<EditOp> = [
    "insert",
    "delete",
    "cursor",
    "ai_accept",
    "ai_reject",
  ];
  if (typeof op !== "string" || !validOps.includes(op as EditOp)) {
    throw new Error(`genius-core:record-edit has unknown op "${String(op)}"`);
  }
  const range = v.range as Record<string, unknown> | undefined;
  if (!range || typeof range !== "object") {
    throw new Error("genius-core:record-edit requires a `range` object");
  }
  const r: EditRange = {
    startLine: Number(range.startLine),
    startCol: Number(range.startCol),
    endLine: Number(range.endLine),
    endCol: Number(range.endCol),
  };
  if (v.text !== undefined && typeof v.text !== "string") {
    throw new Error("genius-core:record-edit `text` must be a string when provided");
  }
  if (
    v.occurredAtMs !== undefined &&
    (typeof v.occurredAtMs !== "number" || !Number.isFinite(v.occurredAtMs))
  ) {
    throw new Error(
      "genius-core:record-edit `occurredAtMs` must be a finite number",
    );
  }
  return {
    projectId: v.projectId as number,
    fileId: v.fileId,
    op: op as EditOp,
    range: r,
    text: typeof v.text === "string" ? v.text : undefined,
    occurredAtMs:
      typeof v.occurredAtMs === "number" ? v.occurredAtMs : undefined,
  };
}

let geniusCoreBootstrapped = false;

/**
 * Boot-time bootstrap so Genius Core is "running" without waiting for the
 * first renderer interaction. Idempotent and best-effort: failures are
 * logged but never block app startup.
 *
 * Privacy note: this does NOT bypass the capture consent gate. The edit
 * logger still drops every record unless the user has opted into telemetry
 * AND enabled the keystroke logger — the gate is enforced per-record in
 * `setupEditLogger`. Here we only (a) pre-warm the logger so capture is
 * ready instantly once permitted, (b) start the nightly idle scheduler when
 * the user enabled it, and (c) flush buffered edits on quit.
 */
async function bootstrapGeniusCore(): Promise<void> {
  if (geniusCoreBootstrapped) return;
  geniusCoreBootstrapped = true;

  let gc: ReturnType<typeof getGeniusCoreSettings> | null = null;
  try {
    gc = getGeniusCoreSettings();
  } catch (err) {
    logger.warn("Genius Core bootstrap: failed to read settings", err);
    return;
  }

  // Pre-warm the edit logger when capture is plausibly active so the first
  // edit isn't dropped while the singleton lazily initialises.
  if (gc.enabled || gc.keystrokeLoggerEnabled) {
    try {
      await ensureEditLogger();
    } catch (err) {
      logger.warn("Genius Core bootstrap: edit logger setup failed", err);
    }
  }

  // Start the nightly distillation idle monitor when the user enabled it.
  // Safe even before the production trainer is wired: idle ticks return
  // early when there is no active project.
  if (gc.nightlyDistillationEnabled) {
    try {
      const sched = await ensureDistillationScheduler();
      sched.start();
    } catch (err) {
      logger.warn("Genius Core bootstrap: distillation scheduler start failed", err);
    }
  }

  // Flush any buffered edits on quit so the ≤debounce-window tail is never
  // lost. Best-effort; guarded against an uninitialised logger.
  try {
    app.on("before-quit", () => {
      try {
        void getEditLogger().flush();
      } catch {
        // logger not initialised or already disposed — nothing to flush
      }
    });
  } catch (err) {
    logger.warn("Genius Core bootstrap: before-quit hook failed", err);
  }
}

export function registerGeniusCoreHandlers(): void {
  ipcMain.handle("genius-core:status", (): GeniusCoreStatusReport => {
    return GeniusCore.status();
  });

  ipcMain.handle("genius-core:init", async (): Promise<GeniusCoreStatusReport> => {
    await GeniusCore.init();
    return GeniusCore.status();
  });

  ipcMain.handle(
    "genius-core:load-context-slot",
    async (_e, projectId: unknown): Promise<GeniusCoreStatusReport> => {
      if (typeof projectId !== "string" || projectId.length === 0) {
        throw new Error("genius-core:load-context-slot requires a projectId string");
      }
      await GeniusCore.loadContextSlot(projectId);
      return GeniusCore.status();
    },
  );

  ipcMain.handle(
    "genius-core:infer",
    async (_e, raw: unknown): Promise<GeniusCoreInferResponse> => {
      const req = assertInferRequest(raw);
      return GeniusCore.infer(req);
    },
  );

  ipcMain.handle(
    "genius-core:stream-infer",
    async (event, raw: unknown): Promise<GeniusCoreInferResponse> => {
      const req = assertInferRequest(raw);
      return GeniusCore.streamInfer(req, (chunk) => {
        if (event.sender.isDestroyed()) return;
        event.sender.send("genius-core:stream-chunk", { chunk });
      });
    },
  );

  ipcMain.handle(
    "genius-core:list-base-models",
    (): GeniusCoreBaseModelListEntry[] => {
      return listBaseModels();
    },
  );

  ipcMain.handle(
    "genius-core:set-base-model",
    async (_e, modelId: unknown): Promise<GeniusCoreStatusReport> => {
      if (typeof modelId !== "string" || modelId.length === 0) {
        throw new Error("genius-core:set-base-model requires a modelId string");
      }
      const target = findBaseModel(modelId);
      if (!target) {
        throw new Error(`Unknown Genius Core base model: ${modelId}`);
      }

      patchGeniusCoreSettings({ baseModelId: target.id });
      logger.info("Genius Core base model updated", { modelId: target.id });

      // Hot-swap the runtime so the new base is ready for the next inference
      // without forcing the user to re-init. Errors here are surfaced but do
      // not abort — the settings change still persists.
      try {
        await GeniusCore.switchBaseModel(target.id);
      } catch (err) {
        logger.warn("switchBaseModel failed (settings still updated)", err);
      }
      return GeniusCore.status();
    },
  );

  ipcMain.handle(
    "genius-core:peek-project-slot",
    async (_e, raw: unknown): Promise<GeniusCoreProjectSlotInfo> => {
      const projectId = projectIdGuard(raw, "genius-core:peek-project-slot");
      try {
        const mgr = await ensureSlotManager();
        const loaded = await mgr.loadSlot(projectId);
        if (!loaded) return emptySlotInfo(projectId);
        return {
          projectId,
          cid: loaded.cid,
          baseModelId: loaded.block.baseModelId,
          adapterBytes: loaded.block.adapterBytes.byteLength,
          createdAtMs: loaded.block.createdAtMs,
          previousCid: loaded.block.previousCid,
        };
      } catch (err) {
        // Renderer-facing peek must never crash routes; surface as an
        // empty slot when the project genuinely lacks one or when the
        // store / DB is unavailable in dev.
        logger.warn("peek-project-slot fell back to empty", err);
        return emptySlotInfo(projectId);
      }
    },
  );

  ipcMain.handle(
    "genius-core:open-project-slot",
    async (_e, raw: unknown): Promise<GeniusCoreProjectSlotInfo> => {
      const projectId = projectIdGuard(raw, "genius-core:open-project-slot");
      const mgr = await ensureSlotManager();
      const loaded = await mgr.loadSlot(projectId);
      if (!loaded) return emptySlotInfo(projectId);
      return {
        projectId,
        cid: loaded.cid,
        baseModelId: loaded.block.baseModelId,
        adapterBytes: loaded.block.adapterBytes.byteLength,
        createdAtMs: loaded.block.createdAtMs,
        previousCid: loaded.block.previousCid,
      };
    },
  );

  ipcMain.handle(
    "genius-core:record-edit",
    async (_e, raw: unknown): Promise<{ accepted: boolean }> => {
      const input = assertRecordEditInput(raw);
      // Track the active project for idle distillation regardless of whether
      // the privacy gate accepts the record below.
      if (Number.isInteger(input.projectId) && input.projectId > 0) {
        lastEditProjectId = input.projectId;
      }
      try {
        const logger_ = await ensureEditLogger();
        const accepted = logger_.record(input);
        return { accepted };
      } catch (err) {
        // Capture path must never crash the editor; log + drop silently.
        logger.warn("record-edit dropped", err);
        return { accepted: false };
      }
    },
  );

  ipcMain.handle(
    "genius-core:flush-edit-log",
    async (): Promise<{ flushed: boolean }> => {
      try {
        const logger_ = await ensureEditLogger();
        await logger_.flush();
        return { flushed: true };
      } catch (err) {
        logger.warn("flush-edit-log failed", err);
        return { flushed: false };
      }
    },
  );

  ipcMain.handle(
    "genius-core:export-edit-session",
    async (_e, raw: unknown): Promise<EditLogEntry[]> => {
      if (!raw || typeof raw !== "object") {
        throw new Error(
          "genius-core:export-edit-session expects an options object",
        );
      }
      const v = raw as Record<string, unknown>;
      const projectId = Number(v.projectId);
      const sinceMs = Number(v.sinceMs);
      const limit =
        v.limit === undefined ? undefined : Number(v.limit);
      return exportEditSession({ projectId, sinceMs, limit });
    },
  );

  ipcMain.handle(
    "genius-core:distillation-status",
    async (): Promise<DistillationStatus> => {
      const sched = await ensureDistillationScheduler();
      return sched.getStatus();
    },
  );

  ipcMain.handle(
    "genius-core:distillation-run-now",
    async (
      _e,
      raw: unknown,
    ): Promise<GeniusCoreDistillationReceiptDto> => {
      if (!raw || typeof raw !== "object") {
        throw new Error(
          "genius-core:distillation-run-now expects an options object",
        );
      }
      const projectId = Number((raw as Record<string, unknown>).projectId);
      if (!Number.isInteger(projectId) || projectId <= 0) {
        throw new Error(
          "genius-core:distillation-run-now requires a positive integer `projectId`",
        );
      }
      const sched = await ensureDistillationScheduler();
      const receipt = await sched.runNow(projectId);
      return toReceiptDto(receipt);
    },
  );

  ipcMain.handle(
    "genius-core:distillation-set-enabled",
    async (_e, raw: unknown): Promise<DistillationStatus> => {
      if (typeof raw !== "boolean") {
        throw new Error(
          "genius-core:distillation-set-enabled requires a boolean argument",
        );
      }
      patchGeniusCoreSettings({ nightlyDistillationEnabled: raw });
      const sched = await ensureDistillationScheduler();
      if (raw) sched.start();
      else sched.stop();
      return sched.getStatus();
    },
  );

  ipcMain.handle(
    "genius-core:get-eval-set",
    async (_e, raw: unknown): Promise<EvalSet | null> => {
      if (!Number.isInteger(raw) || (raw as number) <= 0) {
        throw new Error(
          "genius-core:get-eval-set requires a positive integer projectId",
        );
      }
      const evaluator = await ensureAdapterEvaluator();
      return evaluator.getEvalSet(raw as number);
    },
  );

  ipcMain.handle(
    "genius-core:set-eval-set",
    async (_e, raw: unknown): Promise<EvalSet | null> => {
      if (!raw || typeof raw !== "object") {
        throw new Error("genius-core:set-eval-set expects an options object");
      }
      const o = raw as Record<string, unknown>;
      const projectId = Number(o.projectId);
      if (!Number.isInteger(projectId) || projectId <= 0) {
        throw new Error(
          "genius-core:set-eval-set requires a positive integer projectId",
        );
      }
      const prompts = o.prompts;
      const expectedKeywords = o.expectedKeywords;
      if (!Array.isArray(prompts) || !Array.isArray(expectedKeywords)) {
        throw new Error(
          "genius-core:set-eval-set requires `prompts` and `expectedKeywords` arrays",
        );
      }
      const evaluator = await ensureAdapterEvaluator();
      await evaluator.setEvalSet(
        projectId,
        prompts as string[],
        expectedKeywords as string[][],
      );
      return evaluator.getEvalSet(projectId);
    },
  );

  ipcMain.handle(
    "genius-core:list-adapter-scores",
    async (_e, raw: unknown): Promise<AdapterScoreRow[]> => {
      if (!raw || typeof raw !== "object") {
        throw new Error(
          "genius-core:list-adapter-scores expects an options object",
        );
      }
      const o = raw as Record<string, unknown>;
      const projectId = Number(o.projectId);
      if (!Number.isInteger(projectId) || projectId <= 0) {
        throw new Error(
          "genius-core:list-adapter-scores requires a positive integer projectId",
        );
      }
      const limit =
        typeof o.limit === "number" && Number.isFinite(o.limit)
          ? Math.max(1, Math.min(500, Math.floor(o.limit)))
          : 50;
      const evaluator = await ensureAdapterEvaluator();
      return evaluator.listScores(projectId, limit);
    },
  );

  ipcMain.handle(
    "genius-core:set-rollback-threshold",
    async (_e, raw: unknown): Promise<number> => {
      if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0 || raw > 1) {
        throw new Error(
          "genius-core:set-rollback-threshold requires a number in [0, 1]",
        );
      }
      patchGeniusCoreSettings({ adapterRollbackThreshold: raw });
      return raw;
    },
  );

  ipcMain.handle(
    "genius-core:get-keystroke-overrides",
    (): Record<string, boolean> => {
      return (
        readSettings().geniusCore?.keystrokeLoggerProjectOverrides ?? {}
      );
    },
  );

  ipcMain.handle(
    "genius-core:set-keystroke-override",
    async (
      _e,
      raw: unknown,
    ): Promise<Record<string, boolean>> => {
      if (!raw || typeof raw !== "object") {
        throw new Error(
          "genius-core:set-keystroke-override expects { projectId, enabled? }",
        );
      }
      const v = raw as { projectId?: unknown; enabled?: unknown };
      if (
        !Number.isInteger(v.projectId) ||
        (v.projectId as number) <= 0
      ) {
        throw new Error(
          "genius-core:set-keystroke-override requires a positive integer projectId",
        );
      }
      if (
        v.enabled !== undefined &&
        v.enabled !== null &&
        typeof v.enabled !== "boolean"
      ) {
        throw new Error(
          "genius-core:set-keystroke-override `enabled` must be boolean | null",
        );
      }
      const key = String(v.projectId);
      const prior =
        readSettings().geniusCore?.keystrokeLoggerProjectOverrides ?? {};
      const next: Record<string, boolean> = { ...prior };
      if (v.enabled === undefined || v.enabled === null) {
        delete next[key];
      } else {
        next[key] = v.enabled as boolean;
      }
      patchGeniusCoreSettings({ keystrokeLoggerProjectOverrides: next });
      return next;
    },
  );

  logger.info("Genius Core IPC handlers registered", {
    catalogueSize: GENIUS_CORE_BASE_MODELS.length,
  });

  // Forward distillation progress events to all renderers exactly once.
  if (!distillationProgressForwarderInstalled) {
    distillationProgressForwarderInstalled = true;
    try {
      getDomainEventBus().on(
        "genius_core.distillation.progress",
        (envelope) => {
          try {
            for (const win of BrowserWindow.getAllWindows()) {
              if (win.isDestroyed()) continue;
              const wc = win.webContents;
              if (wc.isDestroyed()) continue;
              wc.send("genius-core:distillation-progress", envelope.payload);
            }
          } catch (err) {
            logger.warn(
              "Failed to forward genius_core.distillation.progress",
              err,
            );
          }
        },
      );
    } catch (err) {
      logger.warn(
        "Failed to subscribe to genius_core.distillation.progress",
        err,
      );
    }
  }

  // Fire-and-forget boot bootstrap: pre-warm capture, start the nightly idle
  // scheduler when enabled, and register the before-quit flush.
  void bootstrapGeniusCore();
}

let distillationProgressForwarderInstalled = false;
