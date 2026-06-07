/**
 * JNS (Joy Name System) IPC handlers — read-only `.joy` name resolution.
 *
 * JNS is the sibling of ENS: ENS resolves `.eth` names via the ETH registrar,
 * JNS resolves `.joy` names via the Joy ENS fork. Resolution is read-only
 * (no signing), so there is no wallet/key path here. All handlers throw on
 * failure per repo convention.
 *
 * Channels registered here MUST also be added to:
 *   - src/ipc/ipc_host.ts (registerJnsHandlers)
 *   - src/preload.ts allowlist
 *   - src/ipc/ipc_client.ts (renderer-side method)
 */

import { ipcMain } from "electron";

import {
  resolveJoyName,
  type JnsChainId,
  type JnsResolution,
} from "@/lib/onchain/jns_resolver";

export function registerJnsHandlers(): void {
  ipcMain.handle(
    "jns:resolve-name",
    async (_e, params: { name: string; chain?: JnsChainId }): Promise<JnsResolution> => {
      if (!params || typeof params.name !== "string" || !params.name.trim()) {
        throw new Error("jns:resolve-name requires a non-empty name");
      }
      return resolveJoyName(params.name, params.chain);
    },
  );
}
