/**
 * Genius Core — production distillation trainer.
 *
 * Bridges the {@link DistillationTrainer} abstraction used by the nightly
 * distillation scheduler to the real local QLoRA engine in
 * `@/lib/local_fine_tuning` (which shells out to a local Python
 * transformers/peft/bitsandbytes environment).
 *
 * ## Training data source
 *
 * Edit-log entries are intentionally hash-only (no raw text is ever
 * persisted — see `edit_logger.ts`), so the edit-log slice handed to
 * `train()` cannot itself produce supervised `{input, output}` pairs. Per
 * product decision, the trainer instead reuses the data flywheel's captured
 * chat Q&A pairs (which carry real text), scoped to the same project
 * (`projectId === appId`) and the run's time window. The edit-log window is
 * still the trigger/intent signal that started the run.
 *
 * The resulting PEFT adapter is written to the fine-tuning store on disk and
 * registered with `LocalFineTuning`; it is NOT promoted into the Genius Core
 * ONNX context slot (the two adapter formats differ), so no `adapterBytes`
 * are returned on the receipt.
 */

import log from "electron-log";

import { buildTrainingDataForProject } from "@/lib/data_flywheel";
import type {
  DistillationReceipt,
  DistillationTrainer,
  DistillationTrainerInput,
} from "@/lib/genius_core/distillation_scheduler";

const logger = log.scope("genius-core/local-trainer");

type SupportedBaseModel =
  | "llama-2-7b"
  | "llama-2-13b"
  | "mistral-7b"
  | "phi-2"
  | "tinyllama"
  | "codellama-7b";

/**
 * Map a Genius Core base-model id (eg. `phi-3-mini-4k-int4`) to a key the
 * local fine-tuning engine supports. Falls back to the smallest model.
 */
function mapBaseModel(baseModelId: string): SupportedBaseModel {
  const id = baseModelId.toLowerCase();
  if (id.includes("phi")) return "phi-2";
  if (id.includes("codellama") || id.includes("code-llama")) {
    return "codellama-7b";
  }
  if (id.includes("mistral")) return "mistral-7b";
  if (id.includes("13b")) return "llama-2-13b";
  if (id.includes("llama-2") || id.includes("llama2")) return "llama-2-7b";
  // tinyllama is the smallest/safest default for unknown ids.
  return "tinyllama";
}

export class LocalDistillationTrainer implements DistillationTrainer {
  async train(input: DistillationTrainerInput): Promise<DistillationReceipt> {
    const startedAt = Date.now();
    const method: "lora" | "qlora" = input.method === "lora" ? "lora" : "qlora";

    const { data } = await buildTrainingDataForProject(
      input.projectId,
      input.windowStartMs,
    );

    if (data.length === 0) {
      throw new Error(
        `Genius Core distillation: no flywheel training pairs for project ${input.projectId} in window — nothing to distill`,
      );
    }

    const baseModel = mapBaseModel(input.baseModelId);
    // Loaded lazily so importing this module (e.g. to register the scheduler)
    // does not pull the Python-backed engine — and its top-level
    // `app.getPath` — into contexts/tests that lack a full Electron app.
    const { LocalFineTuning } = await import("@/lib/local_fine_tuning");
    const ft = new LocalFineTuning();
    await ft.initialize();

    const label = `genius-core-${input.projectId}-${new Date(startedAt)
      .toISOString()
      .slice(0, 19)
      .replace(/[:T]/g, "-")}`;

    const dataset = await ft.createDataset({
      name: label,
      format: "alpaca",
      data,
      metadata: {
        source: "genius_core_distillation",
        projectId: input.projectId,
        pairCount: data.length,
      },
    });

    const job = await ft.createTrainingJob({
      name: label,
      baseModel,
      baseModelPath: "",
      datasetId: dataset.id,
      method,
      metadata: {
        source: "genius_core_distillation",
        projectId: input.projectId,
      },
    });

    logger.info("Genius Core distillation training started", {
      jobId: job.id,
      projectId: input.projectId,
      baseModel,
      method,
      sampleCount: data.length,
    });

    // `startTraining` swallows training failures internally and emits
    // `job:failed` rather than rejecting, so we resolve/reject off the
    // emitter events for this specific job id.
    const finalLoss = await new Promise<number>((resolve, reject) => {
      const onCompleted = (completed: {
        id: string;
        progress?: { loss?: number };
      }) => {
        if (completed.id !== job.id) return;
        cleanup();
        const loss =
          typeof completed.progress?.loss === "number"
            ? completed.progress.loss
            : 0;
        resolve(loss);
      };
      const onFailed = (payload: {
        job?: { id: string };
        error?: string;
      }) => {
        if (payload.job?.id !== job.id) return;
        cleanup();
        reject(new Error(payload.error || "Genius Core distillation training failed"));
      };
      const onProgress = (payload: {
        job?: { id: string };
        progress?: {
          currentStep?: number;
          totalSteps?: number;
          loss?: number;
        };
      }) => {
        if (payload.job?.id !== job.id) return;
        input.onProgress?.({
          step: payload.progress?.currentStep ?? 0,
          totalSteps: payload.progress?.totalSteps ?? null,
          loss:
            typeof payload.progress?.loss === "number"
              ? payload.progress.loss
              : null,
        });
      };
      const cleanup = () => {
        ft.off("job:completed", onCompleted);
        ft.off("job:failed", onFailed);
        ft.off("job:progress", onProgress);
      };

      ft.on("job:completed", onCompleted);
      ft.on("job:failed", onFailed);
      ft.on("job:progress", onProgress);

      ft.startTraining(job.id).catch((err) => {
        cleanup();
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });

    return {
      adapterId: job.id,
      method,
      sampleCount: data.length,
      finalLoss,
      durationMs: Date.now() - startedAt,
      baseModelId: baseModel,
    };
  }
}

/** Factory used by the IPC handler wiring. */
export function createLocalDistillationTrainer(): DistillationTrainer {
  return new LocalDistillationTrainer();
}
