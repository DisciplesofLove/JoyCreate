/**
 * Model Catalog IPC handlers
 *
 * Channels:
 *  - `models:refresh-catalog` — manually triggers the watchdog refresh and
 *    returns the per-provider results so a settings panel can display
 *    "Found N new models from OpenAI".
 *
 * Throw-on-error per repo IPC convention.
 */

import { ipcMain } from "electron";
import { guarded } from "@/ipc/utils/guarded_handle";
import {
  refreshModelCatalog,
  type ProviderRefreshResult,
} from "@/lib/model_catalog_watchdog";

export function registerModelCatalogHandlers(): void {
  ipcMain.handle(
    "models:refresh-catalog",
    guarded("models:refresh-catalog", async (): Promise<ProviderRefreshResult[]> => {
      return refreshModelCatalog();
    }),
  );
}

export default registerModelCatalogHandlers;
