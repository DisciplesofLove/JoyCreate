/**
 * Genius Core local-models adapter.
 *
 * Surfaces Genius Core's curated base-model catalogue under the same
 * `local-models:list-*` family used by Ollama and LM Studio. This is the
 * minimal seam that lets the renderer's `ModelPicker` enumerate Genius
 * Core alongside the other two local providers without each picker hook
 * needing to know about Genius Core's 20-channel IPC surface.
 *
 * The catalogue is static (no disk/HTTP probe); we only gate by the
 * `geniusCore.enabled` setting so disabled installs return `[]` — the
 * same "empty list means not running" convention LM Studio uses.
 */

import { ipcMain } from "electron";
import log from "electron-log";

import { getGeniusCoreSettings } from "@/main/settings";
import type { LocalModel, LocalModelListResponse } from "../ipc_types";
import { listBaseModels } from "./genius_core_handlers";

const logger = log.scope("genius_core_local_models");

/**
 * Map the curated Genius Core catalogue into the renderer-facing
 * `LocalModel[]` shape. Returns `[]` when Genius Core is disabled in
 * settings.
 */
export function fetchGeniusCoreLocalModels(): LocalModelListResponse {
  const enabled = getGeniusCoreSettings().enabled === true;
  if (!enabled) {
    return { models: [] };
  }
  const models: LocalModel[] = listBaseModels().map((entry) => ({
    provider: "genius-core",
    modelName: entry.id,
    displayName: entry.displayName,
  }));
  return { models };
}

export function registerGeniusCoreLocalModelsHandlers(): void {
  ipcMain.handle(
    "local-models:list-genius-core",
    async (): Promise<LocalModelListResponse> => {
      const result = fetchGeniusCoreLocalModels();
      logger.info(
        `Returning ${result.models.length} Genius Core models (enabled=${result.models.length > 0})`,
      );
      return result;
    },
  );
}
