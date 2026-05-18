/**
 * Unified Identity IPC handlers.
 *
 * Channels:
 *   - identity:get-current   → UniversalIdentity | null
 *   - identity:create        → UniversalIdentity (throws on error)
 *   - identity:ens:list      → NameServiceRecord[]
 *   - identity:jns:list      → JNSRegistration[]
 *   - identity:events:list   → IdentityEvent[]
 *
 * Handlers throw on error per AGENTS.md convention.
 */
import { ipcMain, type IpcMainInvokeEvent } from "electron";
import log from "electron-log";
import { IdentityService } from "../../lib/identity_service";
import type { CreateIdentityParams } from "../../types/unified_identity_types";

const logger = log.scope("identity_handlers");

export function registerIdentityHandlers(): void {
  ipcMain.handle("identity:get-current", async (_e: IpcMainInvokeEvent) => {
    try {
      return await IdentityService.getCurrent();
    } catch (err) {
      logger.error("identity:get-current failed", err);
      throw err instanceof Error ? err : new Error(String(err));
    }
  });

  ipcMain.handle(
    "identity:create",
    async (_e: IpcMainInvokeEvent, params: CreateIdentityParams) => {
      try {
        return await IdentityService.create(params);
      } catch (err) {
        logger.error("identity:create failed", err);
        throw err instanceof Error ? err : new Error(String(err));
      }
    },
  );

  ipcMain.handle("identity:ens:list", async (_e: IpcMainInvokeEvent) => {
    try {
      return await IdentityService.listEns();
    } catch (err) {
      logger.error("identity:ens:list failed", err);
      throw err instanceof Error ? err : new Error(String(err));
    }
  });

  ipcMain.handle("identity:jns:list", async (_e: IpcMainInvokeEvent) => {
    try {
      return await IdentityService.listJns();
    } catch (err) {
      logger.error("identity:jns:list failed", err);
      throw err instanceof Error ? err : new Error(String(err));
    }
  });

  ipcMain.handle(
    "identity:events:list",
    async (_e: IpcMainInvokeEvent, args?: { limit?: number }) => {
      try {
        return await IdentityService.listEvents({ limit: args?.limit });
      } catch (err) {
        logger.error("identity:events:list failed", err);
        throw err instanceof Error ? err : new Error(String(err));
      }
    },
  );

  logger.info("Registered 5 identity channels");
}
