/**
 * Genius Core ONNX Runtime — main process backend.
 *
 * Wraps `@huggingface/transformers` (which embeds `onnxruntime-node`) and
 * implements the {@link GeniusCoreBackend} contract. Subsequent phases plug
 * dynamic layer-swapping (Phase 3), context-slot adapters (Phase 4) and
 * P2P shard streaming (Phase 9) into the same surface without changing the
 * renderer-facing API.
 */

import path from "node:path";
import os from "node:os";
import { app } from "electron";
import log from "electron-log";

import {
  GeniusCore,
  type GeniusCoreBackend,
  type GeniusCoreInferRequest,
  type GeniusCoreInferResponse,
  type GeniusCoreStatus,
  type GeniusCoreStatusReport,
} from "@/lib/genius_core";
import {
  GENIUS_CORE_BASE_MODELS,
  findBaseModel,
  type GeniusCoreExecutionProvider,
} from "@/lib/genius_core/model_format";
import { readSettings } from "@/main/settings";
import { getDomainEventBus } from "@/lib/events/domain_event_bus";

const logger = log.scope("genius_core_onnx_main");

type TransformersModule = typeof import("@huggingface/transformers");
let transformersModule: TransformersModule | null = null;

async function loadTransformers(): Promise<TransformersModule> {
  if (!transformersModule) {
    transformersModule = await import("@huggingface/transformers");
  }
  return transformersModule;
}

function resolveCacheDir(): string {
  try {
    return path.join(app.getPath("userData"), "genius-core", "models");
  } catch {
    return path.join(os.tmpdir(), "joycreate-genius-core", "models");
  }
}

function mapProvider(
  pref: GeniusCoreExecutionProvider,
): "auto" | "webgpu" | "dml" | "cpu" {
  switch (pref) {
    case "webgpu":
      return "webgpu";
    case "directml":
      return "dml";
    case "cpu":
      return "cpu";
    default:
      return "auto";
  }
}

interface SessionRefs {
  model: unknown;
  tokenizer: unknown;
  modelId: string;
  executionProvider: string;
  loadedAtMs: number;
  residentBytes: number;
}

export class OnnxRuntimeMain implements GeniusCoreBackend {
  private state: GeniusCoreStatus = "uninitialized";
  private lastError: string | undefined;
  private session: SessionRefs | null = null;
  private executionProvider: string | null = null;
  private vramBudgetGb = 8;
  private lastInference: GeniusCoreStatusReport["lastInference"] = null;
  private loadedContextSlots = new Set<string>();

  async init(): Promise<void> {
    if (this.state === "ready" || this.state === "initializing") return;
    this.state = "initializing";
    this.lastError = undefined;

    try {
      const settings = readSettings();
      const cfg = settings.geniusCore;
      if (!cfg?.enabled) {
        throw new Error(
          "Genius Core is disabled in settings — enable `geniusCore.enabled` first",
        );
      }

      this.vramBudgetGb = cfg.vramBudgetGb ?? 8;
      const epPref = (cfg.executionProvider ?? "auto") as GeniusCoreExecutionProvider;
      this.executionProvider = mapProvider(epPref);

      const transformers = await loadTransformers();
      const cacheDir = resolveCacheDir();
      transformers.env.cacheDir = cacheDir;
      transformers.env.localModelPath = cacheDir;
      transformers.env.allowRemoteModels = true;
      transformers.env.allowLocalModels = true;

      this.state = "ready";
      await getDomainEventBus().publish("genius_core.initialized", {
        executionProvider: this.executionProvider,
        vramBudgetGb: this.vramBudgetGb,
        baseModelId: cfg.baseModelId,
      });
      logger.info("Genius Core ONNX runtime ready", {
        executionProvider: this.executionProvider,
        vramBudgetGb: this.vramBudgetGb,
        baseModelId: cfg.baseModelId,
        cacheDir,
      });
    } catch (err) {
      this.state = "error";
      this.lastError = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }

  async loadBase(): Promise<void> {
    if (this.state === "uninitialized") {
      throw new Error("Call init() before loadBase()");
    }
    const settings = readSettings();
    const baseId = settings.geniusCore?.baseModelId;
    if (!baseId) throw new Error("No `geniusCore.baseModelId` configured");
    const meta = findBaseModel(baseId);
    if (!meta) throw new Error(`Unknown Genius Core base model: ${baseId}`);
    if (this.session?.modelId === baseId) return;

    this.state = "loading-base";
    try {
      const transformers = await loadTransformers();
      const t0 = Date.now();
      const tokenizer = await transformers.AutoTokenizer.from_pretrained(meta.hfRepo);
      const model = await transformers.AutoModelForCausalLM.from_pretrained(
        meta.hfRepo,
        { dtype: meta.quantization === "q4" ? "q4" : "fp16" } as never,
      );
      const loadDurationMs = Date.now() - t0;

      this.session = {
        model,
        tokenizer,
        modelId: baseId,
        executionProvider: this.executionProvider ?? "auto",
        loadedAtMs: Date.now(),
        residentBytes: meta.approxBytes,
      };
      this.state = "ready";

      await getDomainEventBus().publish("genius_core.base.loaded", {
        baseModelId: baseId,
        residentBytes: meta.approxBytes,
        loadDurationMs,
      });
      logger.info("Loaded Genius Core base", { baseId, loadDurationMs });
    } catch (err) {
      this.state = "error";
      this.lastError = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }

  async switchBaseModel(modelId: string): Promise<void> {
    const meta = findBaseModel(modelId);
    if (!meta) {
      throw new Error(`Unknown Genius Core base model: ${modelId}`);
    }
    if (this.session?.modelId === modelId && this.state === "ready") {
      return;
    }
    // Free the previous session so the new base does not double-count
    // against the VRAM budget while it is loading.
    this.session = null;
    if (this.state === "error") this.lastError = undefined;
    if (this.state !== "uninitialized") this.state = "ready";
    // loadBase() reads `geniusCore.baseModelId` from settings; caller patched
    // it before invoking us, so the right model gets loaded.
    await this.loadBase();
  }

  async loadContextSlot(projectId: string): Promise<void> {
    if (this.state === "uninitialized") {
      throw new Error("Call init() before loadContextSlot()");
    }
    // Phase 4 wires the real IPLD context-slot loader. For Phase 1 we just
    // track the request so status reports stay accurate and downstream calls
    // can dedupe re-loads of the same project.
    this.loadedContextSlots.add(projectId);
    await getDomainEventBus().publish("genius_core.context_slot.loaded", {
      projectId,
      slotCid: undefined,
      loadDurationMs: 0,
    });
  }

  async infer(req: GeniusCoreInferRequest): Promise<GeniusCoreInferResponse> {
    return this.runGeneration(req, undefined);
  }

  async streamInfer(
    req: GeniusCoreInferRequest,
    onChunk: (chunk: string) => void,
  ): Promise<GeniusCoreInferResponse> {
    return this.runGeneration(req, onChunk);
  }

  private async runGeneration(
    req: GeniusCoreInferRequest,
    onChunk: ((chunk: string) => void) | undefined,
  ): Promise<GeniusCoreInferResponse> {
    if (!this.session) await this.loadBase();
    if (!this.session) throw new Error("Failed to load base model");

    this.state = "inferring";
    const t0 = Date.now();
    try {
      const transformers = await loadTransformers();
      const tokenizer = this.session.tokenizer as {
        apply_chat_template: (
          msgs: Array<{ role: string; content: string }>,
          opts?: { tokenize?: boolean; add_generation_prompt?: boolean },
        ) => { input_ids: { data?: ArrayLike<bigint | number> } };
        decode: (
          ids: number[] | bigint[],
          opts?: { skip_special_tokens?: boolean },
        ) => string;
      };
      const model = this.session.model as {
        generate: (opts: Record<string, unknown>) => Promise<unknown>;
      };

      const messages = [{ role: "user", content: req.prompt }];
      const promptTensor = tokenizer.apply_chat_template(messages, {
        tokenize: true,
        add_generation_prompt: true,
      });

      const tokensIn = promptTensor.input_ids?.data?.length ?? 0;

      const streamer = onChunk
        ? new transformers.TextStreamer(tokenizer as never, {
            skip_prompt: true,
            skip_special_tokens: true,
            callback_function: (text: string) => {
              try {
                onChunk(text);
              } catch (err) {
                logger.warn("stream chunk handler threw", err);
              }
            },
          } as never)
        : undefined;

      const out = (await model.generate({
        ...(promptTensor as object),
        max_new_tokens: req.maxTokens ?? 256,
        do_sample: typeof req.temperature === "number" && req.temperature > 0,
        temperature: req.temperature ?? 0.0,
        streamer,
      } as Record<string, unknown>)) as
        | { sequences?: { data?: ArrayLike<bigint | number> } }
        | ArrayLike<ArrayLike<bigint | number>>;

      const firstSeq: ArrayLike<bigint | number> | undefined = Array.isArray(out)
        ? (out as ArrayLike<ArrayLike<bigint | number>>)[0]
        : (out as { sequences?: { data?: ArrayLike<bigint | number> } }).sequences?.data;

      const generated: number[] = [];
      if (firstSeq) {
        for (let i = 0; i < firstSeq.length; i++) {
          const v = firstSeq[i];
          generated.push(typeof v === "bigint" ? Number(v) : (v as number));
        }
      }
      const newTokens = generated.slice(tokensIn);
      const text = tokenizer.decode(newTokens, { skip_special_tokens: true });

      const durationMs = Date.now() - t0;
      this.state = "ready";
      this.lastInference = {
        usedShardStream: false,
        tokensOut: newTokens.length,
        durationMs,
        atMs: Date.now(),
      };
      await getDomainEventBus().publish("genius_core.inference.completed", {
        projectId: req.projectId,
        modelId: this.session.modelId,
        executionProvider: this.session.executionProvider,
        tokensIn,
        tokensOut: newTokens.length,
        durationMs,
        usedShardStream: false,
      });

      return {
        text,
        tokensIn,
        tokensOut: newTokens.length,
        durationMs,
        executionProvider: this.session.executionProvider,
        usedShardStream: false,
      };
    } catch (err) {
      this.state = "error";
      this.lastError = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }

  status(): GeniusCoreStatusReport {
    const settings = readSettings();
    return {
      status: this.state,
      enabled: settings.geniusCore?.enabled ?? false,
      executionProvider: this.executionProvider,
      baseModelId: this.session?.modelId ?? settings.geniusCore?.baseModelId ?? null,
      baseLoaded: this.session !== null,
      loadedContextSlots: Array.from(this.loadedContextSlots),
      vramBudgetGb: this.vramBudgetGb,
      vramUsedBytes: this.session?.residentBytes ?? 0,
      lastError: this.lastError,
      lastInference: this.lastInference,
    };
  }

  async shutdown(): Promise<void> {
    this.session = null;
    this.loadedContextSlots.clear();
    this.state = "uninitialized";
  }
}

/**
 * Install the ONNX runtime as the active Genius Core backend. Called once
 * during main process boot; safe to call again to swap in a fresh instance.
 */
export async function activateOnnxRuntimeMainBackend(): Promise<void> {
  const backend = new OnnxRuntimeMain();
  await GeniusCore.setBackend(backend);
  logger.info("Genius Core ONNX main backend activated", {
    catalogueSize: GENIUS_CORE_BASE_MODELS.length,
  });
}
