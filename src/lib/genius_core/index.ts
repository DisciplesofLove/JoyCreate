/**
 * Genius Core — local edge-native neural runtime facade.
 *
 * Sits beside the existing Ollama / LMStudio backends in
 * {@link import("../local_model_manager").LocalModelManager} as a third
 * local provider. Acts as the integrator over:
 *   • ONNX Runtime (main process + renderer Web Worker, Phases 1–2)
 *   • Dynamic VRAM layer-swapping (Phase 3)
 *   • Per-project IPLD context slots (Phase 4)
 *   • Order-respecting edit logger (Phase 5)
 *   • Nightly QLoRA distillation (Phase 6)
 *   • Lit Protocol adapter encryption (Phase 7)
 *   • Stylus DropEdition + Celestia adapter publish (Phase 8)
 *   • Live P2P weight-shard streaming (Phase 9)
 *
 * Phase 0 ships the public contract + state machine only — every concrete
 * subsystem is plugged in by later phases. Calling any method before
 * `init()` throws "not initialized" so failures are loud.
 */

import log from "electron-log";

const logger = log.scope("genius_core");

// ── Public contract ──────────────────────────────────────────────────────

export type GeniusCoreStatus =
  | "uninitialized"
  | "initializing"
  | "ready"
  | "loading-base"
  | "loading-context-slot"
  | "inferring"
  | "error";

export interface GeniusCoreInferRequest {
  /** Optional project id; when set, the matching context slot is layered on top of the base. */
  projectId?: string;
  /** Plain-text prompt for v1; richer message arrays land with Phase 1. */
  prompt: string;
  maxTokens?: number;
  temperature?: number;
}

export interface GeniusCoreInferResponse {
  text: string;
  tokensIn: number;
  tokensOut: number;
  durationMs: number;
  executionProvider: string;
  /** True when this step pulled shards live from peers. */
  usedShardStream: boolean;
}

export interface GeniusCoreStatusReport {
  status: GeniusCoreStatus;
  enabled: boolean;
  executionProvider: string | null;
  baseModelId: string | null;
  baseLoaded: boolean;
  loadedContextSlots: string[];
  vramBudgetGb: number;
  vramUsedBytes: number;
  lastError?: string;
  /**
   * Summary of the most recent inference, populated by the backend so
   * the control panel can surface peer-shard usage and tokens-per-second.
   * `null` until the first inference completes.
   */
  lastInference?: {
    /** True when the last step pulled shards live from peers. */
    usedShardStream: boolean;
    /** Tokens emitted in the last inference. */
    tokensOut: number;
    /** Wall-clock duration of the last inference, ms. */
    durationMs: number;
    /** Wall-clock timestamp when the inference completed. */
    atMs: number;
  } | null;
}

export interface GeniusCoreBackend {
  init(): Promise<void>;
  loadBase(): Promise<void>;
  /**
   * Runtime swap to a new base model. Validates the id against the catalogue,
   * frees the current session, and eagerly loads the new base so the next
   * inference does not incur a cold-start. Caller is responsible for
   * persisting `geniusCore.baseModelId` in user settings before calling.
   */
  switchBaseModel(modelId: string): Promise<void>;
  loadContextSlot(projectId: string): Promise<void>;
  infer(req: GeniusCoreInferRequest): Promise<GeniusCoreInferResponse>;
  streamInfer(
    req: GeniusCoreInferRequest,
    onChunk: (chunk: string) => void,
  ): Promise<GeniusCoreInferResponse>;
  status(): GeniusCoreStatusReport;
  shutdown(): Promise<void>;
}

// ── Phase 0 stub backend ─────────────────────────────────────────────────

class UninitializedBackend implements GeniusCoreBackend {
  async init(): Promise<void> {
    throw new Error(
      "Genius Core backend is not wired yet — Phase 1 installs the ONNX runtime",
    );
  }
  async loadBase(): Promise<void> {
    throw new Error("Genius Core not initialized");
  }
  async switchBaseModel(_modelId: string): Promise<void> {
    throw new Error("Genius Core not initialized");
  }
  async loadContextSlot(_projectId: string): Promise<void> {
    throw new Error("Genius Core not initialized");
  }
  async infer(_req: GeniusCoreInferRequest): Promise<GeniusCoreInferResponse> {
    throw new Error("Genius Core not initialized");
  }
  async streamInfer(
    _req: GeniusCoreInferRequest,
    _onChunk: (chunk: string) => void,
  ): Promise<GeniusCoreInferResponse> {
    throw new Error("Genius Core not initialized");
  }
  status(): GeniusCoreStatusReport {
    return {
      status: "uninitialized",
      enabled: false,
      executionProvider: null,
      baseModelId: null,
      baseLoaded: false,
      loadedContextSlots: [],
      vramBudgetGb: 0,
      vramUsedBytes: 0,
    };
  }
  async shutdown(): Promise<void> {
    /* no-op */
  }
}

// ── Singleton ────────────────────────────────────────────────────────────

class GeniusCoreSingleton {
  private static instance: GeniusCoreSingleton | null = null;
  private backend: GeniusCoreBackend = new UninitializedBackend();

  private constructor() {}

  static getInstance(): GeniusCoreSingleton {
    if (!GeniusCoreSingleton.instance) {
      GeniusCoreSingleton.instance = new GeniusCoreSingleton();
    }
    return GeniusCoreSingleton.instance;
  }

  /**
   * Swap in the concrete backend. Called by Phase 1 once the ONNX runtime
   * module is loaded. Idempotent — replaces any previous backend after
   * gracefully shutting it down.
   */
  async setBackend(next: GeniusCoreBackend): Promise<void> {
    try {
      await this.backend.shutdown();
    } catch (err) {
      logger.warn("backend shutdown threw during swap", err);
    }
    this.backend = next;
  }

  status(): GeniusCoreStatusReport {
    return this.backend.status();
  }

  async init(): Promise<void> {
    return this.backend.init();
  }

  async loadBase(): Promise<void> {
    return this.backend.loadBase();
  }

  async switchBaseModel(modelId: string): Promise<void> {
    if (!modelId) throw new Error("modelId is required");
    return this.backend.switchBaseModel(modelId);
  }

  async loadContextSlot(projectId: string): Promise<void> {
    if (!projectId) throw new Error("projectId is required");
    return this.backend.loadContextSlot(projectId);
  }

  async infer(req: GeniusCoreInferRequest): Promise<GeniusCoreInferResponse> {
    if (!req?.prompt) throw new Error("prompt is required");
    return this.backend.infer(req);
  }

  async streamInfer(
    req: GeniusCoreInferRequest,
    onChunk: (chunk: string) => void,
  ): Promise<GeniusCoreInferResponse> {
    if (!req?.prompt) throw new Error("prompt is required");
    return this.backend.streamInfer(req, onChunk);
  }

  async shutdown(): Promise<void> {
    return this.backend.shutdown();
  }
}

export const GeniusCore = GeniusCoreSingleton.getInstance();
