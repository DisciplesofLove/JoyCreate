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

import { ipcMain } from "electron";
import log from "electron-log";

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
import { readSettings, writeSettings } from "@/main/settings";

const logger = log.scope("genius_core_handlers");

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

/** Lazy distillation-scheduler access mirroring `ensureSlotManager`. */
async function ensureDistillationScheduler() {
  try {
    return getDistillationScheduler();
  } catch {
    return setupDistillationScheduler();
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

      const current = readSettings();
      const prior = current.geniusCore;
      writeSettings({
        geniusCore: {
          enabled: prior?.enabled ?? false,
          vramBudgetGb: prior?.vramBudgetGb ?? 8,
          baseModelId: target.id,
          executionProvider: prior?.executionProvider ?? "auto",
          contextSlotsDir: prior?.contextSlotsDir,
          npuOffloadEnabled: prior?.npuOffloadEnabled ?? false,
          weightStreamingEnabled: prior?.weightStreamingEnabled ?? false,
          keystrokeLoggerEnabled: prior?.keystrokeLoggerEnabled ?? false,
          nightlyDistillationEnabled: prior?.nightlyDistillationEnabled ?? false,
        },
      });
      logger.info("Genius Core base model updated", { modelId: target.id });

      // If the backend is currently live, force it back to uninitialized so
      // the next inference reloads against the new base.
      try {
        await GeniusCore.shutdown();
      } catch (err) {
        logger.warn("shutdown during base swap threw (ignored)", err);
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
          nightlyDistillationEnabled: raw,
        },
      });
      const sched = await ensureDistillationScheduler();
      if (raw) sched.start();
      else sched.stop();
      return sched.getStatus();
    },
  );

  logger.info("Genius Core IPC handlers registered", {
    catalogueSize: GENIUS_CORE_BASE_MODELS.length,
  });
}
