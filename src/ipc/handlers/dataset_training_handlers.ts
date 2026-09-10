/**
 * Dataset Training IPC Handlers
 * Connects Dataset Studio datasets to the training pipeline.
 * Supports local LoRA/QLoRA training and OpenAI fine-tuning.
 */

import { ipcMain, IpcMainInvokeEvent } from "electron";
import log from "electron-log";
import { execSync } from "child_process";

import {
  trainOnDataset,
  getTrainingStatus,
  listTrainingJobs,
  cancelTraining,
  listTrainedModels,
  listBaseModels,
} from "@/lib/dataset_training_service";
import { OPENAI_FINE_TUNE_MODELS } from "@/lib/openai_fine_tuning";
import { detectSystemCapabilities } from "./model_factory_handlers";

import type {
  DatasetTrainingParams,
  DatasetTrainingStatus,
  TrainedModelInfo,
  ListBaseModelsResult,
  TrainingSystemInfo,
  ModelFactorySystemInfo,
} from "../ipc_types";

const logger = log.scope("dataset_training_handlers");

// ============================================================================
// HANDLERS
// ============================================================================

async function handleTrainOnDataset(
  _event: IpcMainInvokeEvent,
  params: DatasetTrainingParams,
): Promise<DatasetTrainingStatus> {
  if (!params.datasetId) {
    throw new Error("datasetId is required");
  }
  if (!params.baseModelId) {
    throw new Error("baseModelId is required");
  }
  if (!params.name) {
    throw new Error("Training job name is required");
  }

  logger.info("Starting dataset training:", params.name, "dataset:", params.datasetId, "provider:", params.openAiConfig ? "openai" : "local");
  return trainOnDataset(params);
}

async function handleGetTrainingStatus(
  _event: IpcMainInvokeEvent,
  jobId: string,
): Promise<DatasetTrainingStatus | null> {
  if (!jobId) {
    throw new Error("jobId is required");
  }
  return getTrainingStatus(jobId);
}

async function handleListTrainingJobs(): Promise<DatasetTrainingStatus[]> {
  return listTrainingJobs();
}

async function handleCancelTraining(
  _event: IpcMainInvokeEvent,
  jobId: string,
): Promise<void> {
  if (!jobId) {
    throw new Error("jobId is required");
  }
  logger.info("Cancelling training job:", jobId);
  return cancelTraining(jobId);
}

async function handleListTrainedModels(): Promise<TrainedModelInfo[]> {
  return listTrainedModels();
}

async function handleListBaseModels(): Promise<ListBaseModelsResult> {
  return listBaseModels();
}

async function handleGetTrainingSystemInfo(): Promise<TrainingSystemInfo> {
  // One detection, shared. This used to be a second copy that probed packages
  // with "python3" regardless of which interpreter had answered, so on Windows
  // it reported a fully-installed toolchain as having nothing.
  const base = await detectSystemCapabilities();

  return {
    ...base,
    // The OpenAI path is this handler's own concern: it can fine-tune through
    // the API on a machine with no GPU and no local Python at all.
    hasOpenAiKey: Boolean(process.env.OPENAI_API_KEY),
    openAiModels: OPENAI_FINE_TUNE_MODELS.map((m) => m.id),
  };
}

// ============================================================================
// REGISTER HANDLERS
// ============================================================================

export function registerDatasetTrainingHandlers() {
  logger.info("Registering dataset training handlers...");

  ipcMain.handle("training:train-on-dataset", handleTrainOnDataset);
  ipcMain.handle("training:get-status", handleGetTrainingStatus);
  ipcMain.handle("training:list-jobs", handleListTrainingJobs);
  ipcMain.handle("training:cancel", handleCancelTraining);
  ipcMain.handle("training:list-trained-models", handleListTrainedModels);
  ipcMain.handle("training:list-base-models", handleListBaseModels);
  ipcMain.handle("training:get-system-info", handleGetTrainingSystemInfo);

  logger.info("Dataset training handlers registered");
}
