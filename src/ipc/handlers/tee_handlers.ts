/**
 * Verifiable-inference (TEE) IPC handlers.
 *
 * Wraps the provider-agnostic attestation layer (local | optimistic | lit |
 * nitro). The default mode is "local" (zero cost, no chain writes), so these
 * handlers are safe to call in demos. Switch via JOY_TEE_MODE.
 *
 * Channels registered here MUST also be added to:
 *   - src/ipc/ipc_host.ts (registerTeeHandlers)
 *   - src/preload.ts allowlist
 *   - src/ipc/ipc_client.ts (renderer-side methods)
 */

import { ipcMain } from "electron";
import { ethers } from "ethers";
import log from "electron-log";

import { jcnKeyManager } from "@/lib/jcn_key_manager";
import {
  DEFAULT_ERC8004_CHAIN,
  ERC8004_RPC,
  type Erc8004ChainId,
} from "@/config/erc8004";
import {
  resolveTeeMode,
  isTeeReady,
  resolveLitConfig,
  resolveNitroConfig,
  proofKindForMode,
} from "@/config/tee";
import {
  runVerifiedInference,
  type VerifiedInferenceRecord,
} from "@/lib/tee/inference_orchestrator";

const logger = log.scope("tee_handlers");

const SUPPORTED_CHAINS: readonly Erc8004ChainId[] = ["arbitrumSepolia", "arbitrumOne"];

function resolveChain(value: unknown): Erc8004ChainId {
  if (typeof value === "string" && (SUPPORTED_CHAINS as readonly string[]).includes(value)) {
    return value as Erc8004ChainId;
  }
  if (value == null) return DEFAULT_ERC8004_CHAIN;
  throw new Error(`chain must be one of ${SUPPORTED_CHAINS.join(", ")}, got ${String(value)}`);
}

async function loadWallet(chain: Erc8004ChainId): Promise<ethers.Wallet> {
  await jcnKeyManager.initialize();
  const keys = await jcnKeyManager.listKeys("chain");
  const active = keys.find((k) => k.active && k.algorithm === "secp256k1");
  if (!active) {
    throw new Error("no active chain (secp256k1) key in jcnKeyManager — import one in Settings");
  }
  const pk = await jcnKeyManager.getPrivateKey(active.keyId);
  if (!pk) throw new Error("active chain key has no private material");
  const provider = new ethers.JsonRpcProvider(ERC8004_RPC[chain]);
  const hex = pk.toString("hex");
  return new ethers.Wallet(hex.startsWith("0x") ? hex : `0x${hex}`, provider);
}

export interface TeeStatus {
  mode: ReturnType<typeof resolveTeeMode>;
  ready: boolean;
  proofKind: ReturnType<typeof proofKindForMode>;
  litConfigured: boolean;
  nitroConfigured: boolean;
}

export function registerTeeHandlers(): void {
  // --- status -----------------------------------------------------------
  ipcMain.handle("tee:status", async (): Promise<TeeStatus> => {
    const mode = resolveTeeMode();
    return {
      mode,
      ready: isTeeReady(mode),
      proofKind: proofKindForMode(mode),
      litConfigured: resolveLitConfig() !== null,
      nitroConfigured: resolveNitroConfig() !== null,
    };
  });

  // --- run verified inference (attest + optional on-chain write) --------
  ipcMain.handle(
    "tee:run-verified-inference",
    async (
      _e,
      params: {
        chain?: string;
        modelId: string;
        input: string;
        output: string;
        serverAgentId?: string;
        score?: number;
        writeOnChain?: boolean;
        anchorCelestia?: boolean;
      },
    ): Promise<VerifiedInferenceRecord> => {
      const chain = resolveChain(params?.chain);
      if (!params?.modelId) throw new Error("modelId is required");
      if (params?.input == null) throw new Error("input is required");
      if (params?.output == null) throw new Error("output is required");

      const mode = resolveTeeMode();
      // local mode never signs/writes, so no wallet is needed.
      const wallet = mode === "local" ? undefined : await loadWallet(chain);

      const record = await runVerifiedInference(wallet, {
        chain,
        modelId: params.modelId,
        input: params.input,
        output: params.output,
        serverAgentId: params.serverAgentId,
        score: params.score,
        writeOnChain: params.writeOnChain,
        anchorCelestia: params.anchorCelestia,
      });
      logger.info(`verified inference mode=${record.mode} digest=${record.quote.digest}`);
      return record;
    },
  );
}
