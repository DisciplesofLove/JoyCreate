/**
 * MCP Tools — local models and the fine-tuning factory.
 *
 * Routed through the registered `model-registry:*` and `model-factory:*` IPC
 * channels.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { invokeHandler, runTool, toolError } from "./invoke_handler";

export function registerNeuralModelTools(server: McpServer) {
  server.registerTool(
    "joycreate_model_list_local",
    {
      description: "List models available locally in the JoyCreate model registry.",
      inputSchema: {
        limit: z.number().optional().describe("Max results"),
      },
    },
    async (params) => runTool("joycreate_model_list_local", () =>
      invokeHandler("model-registry:list-local", params)),
  );

  server.registerTool(
    "joycreate_model_download",
    {
      description:
        "Download a model into the local registry. Returns a download id; progress is " +
        "reported on the download-status channel.",
      inputSchema: {
        modelId: z.string().describe("Model identifier to download"),
        source: z.string().optional().describe("Source, e.g. huggingface"),
      },
    },
    async (params) => runTool("joycreate_model_download", () =>
      invokeHandler("model-registry:download", params)),
  );

  server.registerTool(
    "joycreate_model_finetune",
    {
      description:
        "Start a LoRA / QLoRA fine-tuning run. Requires Python with transformers and " +
        "peft installed — check model-factory system info first. Returns a job id.",
      inputSchema: {
        baseModel: z.string().describe("Base model to fine-tune"),
        datasetId: z.string().describe("Dataset to train on"),
        method: z
          .enum(["lora", "qlora", "full"])
          .optional()
          .describe("Fine-tuning method. Default qlora on constrained GPUs."),
        hyperparameters: z
          .record(z.any())
          .optional()
          .describe("loraRank, loraAlpha, loraDropout, epochs, learningRate, ..."),
      },
    },
    async (params) =>
      runTool("joycreate_model_finetune", async () => {
        // `model-factory:start-training` takes a job ID string, not a request.
        // This passed the whole params object straight through, so every call
        // died on "Training job not found: [object Object]" — the tool could
        // never start a run at all. Creating the job first is what the UI does.
        const method = params.method ?? "qlora";
        const hp = (params.hyperparameters ?? {}) as Record<string, unknown>;

        const job = await invokeHandler("model-factory:create-job", {
          name: `${params.baseModel} · ${method}`,
          baseModelSource: "huggingface",
          baseModelId: params.baseModel,
          method,
          datasetPath: params.datasetId,
          datasetFormat: "alpaca",
          hyperparameters: {
            epochs: Number(hp.epochs ?? 3),
            batchSize: Number(hp.batchSize ?? 1),
            learningRate: Number(hp.learningRate ?? 2e-4),
            ...hp,
          },
        });

        if (!job?.id) throw new Error("training job was not created");

        // Throws with the preflight's reason when this machine cannot run the
        // requested method — a missing package, or QLoRA without CUDA.
        await invokeHandler("model-factory:start-training", job.id);

        return {
          jobId: job.id,
          method,
          baseModel: params.baseModel,
          status: "training",
          note:
            "Runs for hours as a child process. The job is persisted, so poll " +
            "model-factory:get-job — and if JoyCreate restarts, the run is marked " +
            "interrupted rather than disappearing.",
        };
      }),
  );

  server.registerTool(
    "joycreate_model_publish",
    {
      description:
        "Publish a model to Joy Marketplace. Models go through the same encrypted " +
        "publish path as every other asset.",
      inputSchema: {
        modelId: z.string().describe("Model id (unused — see the error text)"),
      },
    },
    async () =>
      toolError(
        "joycreate_model_publish is not a separate path. Publishing goes through " +
          "joycreate_publish_asset, which encrypts the weights, pins them, and mints on " +
          "the store's drop contract. Read the model file and call " +
          "joycreate_publish_asset with its bytes and assetType 'model'.",
      ),
  );

  server.registerTool(
    "joycreate_model_infer",
    {
      description:
        "Run inference against a local model. Use the chat tools for conversational " +
        "inference.",
      inputSchema: {
        model: z.string().describe("Model id"),
        prompt: z.string().describe("Prompt"),
      },
    },
    async () =>
      toolError(
        "joycreate_model_infer has no dedicated IPC handler. Use the chat tools for " +
          "conversational inference, or joycreate_compute_smart_route to dispatch a " +
          "request to the best available provider.",
      ),
  );
}
