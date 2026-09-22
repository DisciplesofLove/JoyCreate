/**
 * Backup & Restore IPC handlers.
 *
 * Thin wrappers over `@/lib/backup_service`. All handlers throw on error, per
 * the repo convention — a backup that reports `{success:false}` inside a
 * successful envelope is exactly the failure this feature cannot afford.
 */

import path from "node:path";
import { shell } from "electron";
import log from "electron-log";

import { createLoggedHandler } from "./safe_handle";
import {
  cancelPendingRestore,
  createBackup,
  deleteBackup,
  getBackupDir,
  getPendingRestore,
  listBackups,
  restoreBackup,
  type BackupKind,
} from "@/lib/backup_service";

const logger = log.scope("backup_handlers");
const handle = createLoggedHandler(logger);

export function registerBackupHandlers(): void {
  handle("backup:list", async () => listBackups());

  handle(
    "backup:create",
    async (_, params?: { name?: string; kind?: BackupKind }) =>
      createBackup({ name: params?.name, kind: params?.kind }),
  );

  handle("backup:delete", async (_, params: { id: string }) => {
    if (!params?.id) throw new Error("backup id is required");
    deleteBackup(params.id);
    return { id: params.id, deleted: true };
  });

  handle("backup:restore", async (_, params: { id: string }) => {
    if (!params?.id) throw new Error("backup id is required");
    return restoreBackup(params.id);
  });

  handle("backup:pending-restore", async () => getPendingRestore());

  handle("backup:cancel-restore", async () => ({
    cancelled: cancelPendingRestore(),
  }));

  // "Download" on a snapshot opens its folder rather than streaming bytes
  // through IPC: a full backup is gigabytes, and the file is already on this
  // machine — the useful action is showing the user where.
  handle("backup:reveal", async (_, params?: { id?: string }) => {
    const target = params?.id
      ? path.join(getBackupDir(), params.id)
      : getBackupDir();
    await shell.openPath(target);
    return { path: target };
  });

  logger.info("Backup handlers registered (7 channels)");
}
