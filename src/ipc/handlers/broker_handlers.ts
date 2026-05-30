/**
 * ERC-1144 Interface Broker IPC handlers — emit machine-readable interface
 * blueprints for marketplace resources (store / drop / agent).
 *
 * All reads; no wallet needed. Handlers throw on failure per repo convention.
 *
 * Channels registered here MUST also be added to:
 *   - src/ipc/ipc_host.ts (registerBrokerHandlers)
 *   - src/preload.ts allowlist
 *   - src/ipc/ipc_client.ts (renderer-side methods)
 */

import { ipcMain } from "electron";
import log from "electron-log";

import { DEFAULT_X402_CHAIN, type X402ChainId } from "@/config/x402";
import {
  buildAgentBlueprint,
  buildDropBlueprint,
  buildStoreBlueprint,
} from "@/lib/onchain/interface_broker";

const logger = log.scope("broker_handlers");

const SUPPORTED_CHAINS: readonly X402ChainId[] = ["arbitrumSepolia", "arbitrumOne"];

function resolveChain(value: unknown): X402ChainId {
  if (typeof value === "string" && (SUPPORTED_CHAINS as readonly string[]).includes(value)) {
    return value as X402ChainId;
  }
  if (value == null) return DEFAULT_X402_CHAIN;
  throw new Error(`chain must be one of ${SUPPORTED_CHAINS.join(", ")}, got ${String(value)}`);
}

export function registerBrokerHandlers(): void {
  ipcMain.handle(
    "broker:drop-blueprint",
    async (_e, params: { chain?: string; dropId: string }) => {
      const chain = resolveChain(params?.chain);
      if (!params?.dropId) throw new Error("dropId is required");
      logger.info(`broker drop blueprint: ${params.dropId} on ${chain}`);
      return buildDropBlueprint(chain, params.dropId);
    },
  );

  ipcMain.handle(
    "broker:store-blueprint",
    async (_e, params: { chain?: string; storeId: string }) => {
      const chain = resolveChain(params?.chain);
      if (!params?.storeId) throw new Error("storeId is required");
      logger.info(`broker store blueprint: ${params.storeId} on ${chain}`);
      return buildStoreBlueprint(chain, params.storeId);
    },
  );

  ipcMain.handle(
    "broker:agent-blueprint",
    async (_e, params: { chain?: string; agentId: string }) => {
      const chain = resolveChain(params?.chain);
      if (!params?.agentId) throw new Error("agentId is required");
      logger.info(`broker agent blueprint: ${params.agentId} on ${chain}`);
      return buildAgentBlueprint(chain, params.agentId);
    },
  );
}
