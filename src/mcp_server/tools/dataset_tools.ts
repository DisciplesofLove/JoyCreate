/**
 * MCP Tools — Dataset Studio.
 *
 * Routed through the registered `dataset-studio:*` IPC channels.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { invokeHandler, runTool, toolError } from "./invoke_handler";

export function registerDatasetTools(server: McpServer) {
  server.registerTool(
    "joycreate_dataset_create",
    {
      description: "Create a dataset in JoyCreate Dataset Studio.",
      inputSchema: {
        name: z.string().describe("Dataset name"),
        description: z.string().optional().describe("Dataset description"),
        modality: z
          .string()
          .optional()
          .describe("text, image, audio, video or tabular"),
      },
    },
    async (params) => runTool("joycreate_dataset_create", () =>
      invokeHandler("dataset-studio:create-dataset", params)),
  );

  server.registerTool(
    "joycreate_dataset_list",
    {
      description: "List datasets in JoyCreate Dataset Studio.",
      inputSchema: {
        limit: z.number().optional().describe("Max results"),
      },
    },
    async (params) => runTool("joycreate_dataset_list", () =>
      invokeHandler("dataset-studio:list-datasets", params)),
  );

  server.registerTool(
    "joycreate_dataset_generate_synthetic",
    {
      description:
        "Start a synthetic data generation job for a dataset. Returns the job id; " +
        "poll it with the job status channel.",
      inputSchema: {
        datasetId: z.string().describe("Target dataset id"),
        prompt: z.string().optional().describe("Generation prompt or schema"),
        count: z.number().optional().describe("Number of items to generate"),
        model: z.string().optional().describe("Model to generate with"),
      },
    },
    async (params) => runTool("joycreate_dataset_generate_synthetic", () =>
      invokeHandler("dataset-studio:create-generation-job", params)),
  );

  server.registerTool(
    "joycreate_dataset_publish",
    {
      description:
        "Publish a dataset to Joy Marketplace. Datasets go through the same encrypted " +
        "publish path as every other asset.",
      inputSchema: {
        datasetId: z.string().describe("Dataset id (unused — see the error text)"),
      },
    },
    async () =>
      toolError(
        "joycreate_dataset_publish is not a separate path. Publishing goes through " +
          "joycreate_publish_asset, which encrypts the content, pins it, and mints on " +
          "the store's drop contract. Export the dataset to a file, then call " +
          "joycreate_publish_asset with its bytes and assetType 'dataset'.",
      ),
  );
}
