/**
 * Aggregator for Data + Backend Layer system prompts.
 *
 * Combines the four orthogonal knobs (primary store, server runtime,
 * read index, blob storage) into a single composite system-prompt string
 * to inject into the chat handler.
 *
 * Each knob receives an AVAILABLE or NOT_AVAILABLE variant based on
 * runtime readiness — so the model knows whether to emit working code
 * or a <joy-add-integration> tag.
 */

import type { DataLayerConfig, DataLayerStatus } from "@/shared/data_layer_types";
import { primaryStorePrompt } from "./primary_store_prompts";
import { serverRuntimePrompt } from "./server_runtime_prompts";
import { readIndexPrompt, blobStoragePrompt } from "./addendum_prompts";

export interface DataLayerPromptStatus {
  primaryConfigured: boolean;
  serverConfigured: boolean;
  indexConfigured: boolean;
  blobConfigured: boolean;
}

/**
 * Compose the data-layer system prompt block for a given app config.
 * Returns an empty string if config is null/undefined so callers can
 * safely concatenate.
 */
export function getDataLayerPrompts(
  config: DataLayerConfig | null | undefined,
  status: DataLayerPromptStatus,
): string {
  if (!config) return "";
  const parts = [
    primaryStorePrompt(config.primaryStore, status.primaryConfigured),
    serverRuntimePrompt(config.serverRuntime, status.serverConfigured),
    readIndexPrompt(config.readIndex, status.indexConfigured),
    blobStoragePrompt(config.blobStorage, status.blobConfigured),
  ]
    .map((s) => (s ?? "").trim())
    .filter(Boolean);
  if (parts.length === 0) return "";
  return ["# Data + Backend Layer", ...parts].join("\n\n");
}

/**
 * Convenience: derive a DataLayerPromptStatus from a DataLayerStatus
 * record (the IPC handler returns the latter; chat handlers want the former).
 */
export function toPromptStatus(status: DataLayerStatus): DataLayerPromptStatus {
  return {
    primaryConfigured: status.active.primaryStore.configured,
    serverConfigured: status.active.serverRuntime.configured,
    indexConfigured: status.active.readIndex.configured,
    blobConfigured: status.active.blobStorage.configured,
  };
}

export { primaryStorePrompt, serverRuntimePrompt, readIndexPrompt, blobStoragePrompt };
