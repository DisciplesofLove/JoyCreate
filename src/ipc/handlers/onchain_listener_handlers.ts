/**
 * IPC handlers for the DropERC1155 on-chain listener.
 *
 *   onchain:listener:start          → boots subscription
 *   onchain:listener:stop           → tears down
 *   onchain:listener:status         → { status, lastError, contract }
 *   onchain:listener:replay-since   → backfill from a block (idempotent)
 */

import { ipcMain } from "electron";
import log from "electron-log";

import { getDropEventListener } from "@/lib/onchain/drop_event_listener";

const logger = log.scope("onchain_listener_handlers");

export function registerOnchainListenerHandlers(): void {
  const listener = getDropEventListener();

  ipcMain.handle("onchain:listener:start", async () => {
    await listener.start();
    return listener.getStatus();
  });

  ipcMain.handle("onchain:listener:stop", async () => {
    listener.stop();
    return listener.getStatus();
  });

  ipcMain.handle("onchain:listener:status", async () => {
    return listener.getStatus();
  });

  ipcMain.handle("onchain:listener:replay-since", async (_event, fromBlock: number) => {
    if (typeof fromBlock !== "number" || !Number.isFinite(fromBlock) || fromBlock < 0) {
      throw new Error("fromBlock must be a non-negative finite number");
    }
    return listener.replaySince(fromBlock);
  });

  logger.info("onchain listener handlers registered");
}
