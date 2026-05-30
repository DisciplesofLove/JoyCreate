/**
 * ERC-8004 (Trustless Agents) IPC handlers — wraps the Identity / Reputation /
 * Validation Stylus registries.
 *
 * Reads use a JsonRpcProvider; writes load the active secp256k1 key from
 * jcnKeyManager and sign locally. All handlers throw on failure per repo
 * convention.
 *
 * Channels registered here MUST also be added to:
 *   - src/ipc/ipc_host.ts (registerErc8004Handlers)
 *   - src/preload.ts allowlist
 *   - src/ipc/ipc_client.ts (renderer-side methods)
 */

import { ipcMain } from "electron";
import { ethers } from "ethers";
import log from "electron-log";

import { jcnKeyManager } from "@/lib/jcn_key_manager";
import {
  ERC8004_RPC,
  DEFAULT_ERC8004_CHAIN,
  type Erc8004ChainId,
  isErc8004Ready,
} from "@/config/erc8004";
import {
  acceptFeedback,
  agentCount,
  getAgent,
  getReputationScore,
  getValidationRequest,
  getValidationResponse,
  isFeedbackAuthorized,
  registerAgent,
  resolveByAddress,
  resolveByDomain,
  submitFeedback,
  updateAgent,
  validationRequest,
  validationResponse,
} from "@/lib/onchain/erc8004_client";

const logger = log.scope("erc8004_handlers");

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

export function registerErc8004Handlers(): void {
  // --- status -----------------------------------------------------------
  ipcMain.handle("erc8004:status", async (_e, params?: { chain?: string }) => {
    const chain = resolveChain(params?.chain);
    return { chain, ready: isErc8004Ready(chain) };
  });

  // --- identity ---------------------------------------------------------
  ipcMain.handle(
    "erc8004:register-agent",
    async (_e, params: { chain?: string; agentDomain: string }) => {
      const chain = resolveChain(params?.chain);
      if (!params?.agentDomain) throw new Error("agentDomain is required");
      const wallet = await loadWallet(chain);
      const result = await registerAgent(wallet, {
        chain,
        agentDomain: params.agentDomain,
        agentAddress: wallet.address,
      });
      logger.info(`registered agent ${result.agentId} for ${wallet.address}`);
      return result;
    },
  );

  ipcMain.handle(
    "erc8004:update-agent",
    async (_e, params: { chain?: string; agentId: string; newDomain: string; newAddress: string }) => {
      const chain = resolveChain(params?.chain);
      if (!params?.agentId) throw new Error("agentId is required");
      if (!params?.newAddress) throw new Error("newAddress is required");
      const wallet = await loadWallet(chain);
      return updateAgent(wallet, {
        chain,
        agentId: params.agentId,
        newDomain: params.newDomain,
        newAddress: params.newAddress,
      });
    },
  );

  ipcMain.handle("erc8004:get-agent", async (_e, params: { chain?: string; agentId: string }) => {
    const chain = resolveChain(params?.chain);
    if (!params?.agentId) throw new Error("agentId is required");
    return getAgent(chain, params.agentId);
  });

  ipcMain.handle(
    "erc8004:resolve-by-address",
    async (_e, params: { chain?: string; agentAddress: string }) => {
      const chain = resolveChain(params?.chain);
      if (!params?.agentAddress) throw new Error("agentAddress is required");
      const agentId = await resolveByAddress(chain, params.agentAddress);
      return { agentId };
    },
  );

  ipcMain.handle(
    "erc8004:resolve-by-domain",
    async (_e, params: { chain?: string; agentDomain: string }) => {
      const chain = resolveChain(params?.chain);
      if (!params?.agentDomain) throw new Error("agentDomain is required");
      const agentId = await resolveByDomain(chain, params.agentDomain);
      return { agentId };
    },
  );

  ipcMain.handle("erc8004:agent-count", async (_e, params?: { chain?: string }) => {
    const chain = resolveChain(params?.chain);
    const total = await agentCount(chain);
    return { total };
  });

  // --- reputation -------------------------------------------------------
  ipcMain.handle(
    "erc8004:accept-feedback",
    async (_e, params: { chain?: string; clientId: string; serverId: string }) => {
      const chain = resolveChain(params?.chain);
      if (!params?.clientId || !params?.serverId) {
        throw new Error("clientId and serverId are required");
      }
      const wallet = await loadWallet(chain);
      return acceptFeedback(wallet, { chain, clientId: params.clientId, serverId: params.serverId });
    },
  );

  ipcMain.handle(
    "erc8004:submit-feedback",
    async (
      _e,
      params: { chain?: string; clientId: string; serverId: string; score: number; feedbackUri?: string },
    ) => {
      const chain = resolveChain(params?.chain);
      if (!params?.clientId || !params?.serverId) {
        throw new Error("clientId and serverId are required");
      }
      if (typeof params.score !== "number") throw new Error("score must be a number in [0,100]");
      const wallet = await loadWallet(chain);
      return submitFeedback(wallet, {
        chain,
        clientId: params.clientId,
        serverId: params.serverId,
        score: params.score,
        feedbackUri: params.feedbackUri,
      });
    },
  );

  ipcMain.handle(
    "erc8004:is-feedback-authorized",
    async (_e, params: { chain?: string; clientId: string; serverId: string }) => {
      const chain = resolveChain(params?.chain);
      if (!params?.clientId || !params?.serverId) {
        throw new Error("clientId and serverId are required");
      }
      const authorized = await isFeedbackAuthorized(chain, params.clientId, params.serverId);
      return { authorized };
    },
  );

  ipcMain.handle(
    "erc8004:get-reputation",
    async (_e, params: { chain?: string; serverId: string }) => {
      const chain = resolveChain(params?.chain);
      if (!params?.serverId) throw new Error("serverId is required");
      return getReputationScore(chain, params.serverId);
    },
  );

  // --- validation -------------------------------------------------------
  ipcMain.handle(
    "erc8004:validation-request",
    async (
      _e,
      params: { chain?: string; validator: string; serverAgentId: string; dataHash: string },
    ) => {
      const chain = resolveChain(params?.chain);
      if (!params?.validator) throw new Error("validator is required");
      if (!params?.serverAgentId) throw new Error("serverAgentId is required");
      if (!params?.dataHash) throw new Error("dataHash is required");
      const wallet = await loadWallet(chain);
      return validationRequest(wallet, {
        chain,
        validator: params.validator,
        serverAgentId: params.serverAgentId,
        dataHash: params.dataHash,
      });
    },
  );

  ipcMain.handle(
    "erc8004:validation-response",
    async (_e, params: { chain?: string; dataHash: string; response: number }) => {
      const chain = resolveChain(params?.chain);
      if (!params?.dataHash) throw new Error("dataHash is required");
      if (typeof params.response !== "number") throw new Error("response must be a number in [0,100]");
      const wallet = await loadWallet(chain);
      return validationResponse(wallet, {
        chain,
        dataHash: params.dataHash,
        response: params.response,
      });
    },
  );

  ipcMain.handle(
    "erc8004:get-validation",
    async (_e, params: { chain?: string; dataHash: string }) => {
      const chain = resolveChain(params?.chain);
      if (!params?.dataHash) throw new Error("dataHash is required");
      const request = await getValidationRequest(chain, params.dataHash);
      const response = await getValidationResponse(chain, params.dataHash);
      return { request, response };
    },
  );

  logger.info("ERC-8004 handlers registered");
}
