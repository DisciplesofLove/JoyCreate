/**
 * LR12 — Runtime invoke + metering IPC handler.
 *
 * Wraps the local skill runtime (LR8–LR10) with per-invocation metering and an
 * OPTIONAL ERC-8004 reputation feedback submission (LR3). Feedback is signed by
 * the active jcnKeyManager chain wallet, so the wallet never leaves the main
 * process. Handlers throw on error per repo convention.
 */

import { ipcMain } from "electron";
import { ethers } from "ethers";
import log from "electron-log";

import { jcnKeyManager } from "@/lib/jcn_key_manager";
import { ERC8004_RPC, type Erc8004ChainId } from "@/config/erc8004";
import { DEFAULT_GLUE_CHAIN, type GlueChainId } from "@/config/glue";
import { invokeAndMeter, type RuntimeReceipt } from "@/lib/onchain/runtime_metering";
import { getAgent } from "@/lib/onchain/erc8004_client";
import { resolveSkill } from "@/lib/onchain/skill_runtime";
import {
  bridgeIdentityToA2a,
  LRA_RUNTIME_CAPABILITY,
  type BridgeResult,
} from "@/lib/onchain/lra_a2a_bridge";
import { createLraRuntimeExecutor } from "@/lib/onchain/lra_a2a_executor";
import { registerA2aExecutor } from "@/ipc/handlers/a2a_handlers";
import type { A2ACurrency } from "@/db/a2a_schema";
import type { CreateListingInput } from "@/lib/a2a_economy";

const logger = log.scope("runtime_handlers");

const SUPPORTED_CHAINS: readonly GlueChainId[] = ["arbitrumSepolia", "arbitrumOne"];

function resolveChain(value: unknown): GlueChainId {
  if (typeof value === "string" && (SUPPORTED_CHAINS as readonly string[]).includes(value)) {
    return value as GlueChainId;
  }
  if (value == null) return DEFAULT_GLUE_CHAIN;
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

export interface RuntimeInvokeParams {
  chain?: string;
  agentId: string;
  input: string;
  /** License terms object or SPDX string granting runtimeExecution. */
  license?: unknown;
  dropId?: string;
  buyer?: string;
  /** When true, submit ERC-8004 reputation feedback after a successful run. */
  submitFeedback?: boolean;
  /** Consumer (client) agentId leaving the feedback. Required when submitFeedback. */
  clientId?: string;
  /** Score in [0,100]; defaults to 100 for a successful run. */
  feedbackScore?: number;
  /** Optional IPFS/HTTP URI of a detailed feedback document. */
  feedbackUri?: string;
}

export interface RuntimeBridgeA2aParams {
  chain?: string;
  /** Local agents.id the A2A principal is anchored to. */
  localAgentId: number;
  /** On-chain ERC-8004 agentId to mirror into the A2A economy. */
  erc8004AgentId: string;
  listingName?: string;
  description?: string;
  pricing?: {
    pricingModel?: CreateListingInput["pricingModel"];
    priceAmount?: string;
    currency?: A2ACurrency;
  };
}

export function registerRuntimeHandlers(): void {
  // LR14: expose the local LRA runtime as an A2A executor so other agents can
  // discover → quote → escrow → invoke it behind the license + PoU gate.
  registerA2aExecutor(LRA_RUNTIME_CAPABILITY, createLraRuntimeExecutor());

  ipcMain.handle("runtime:invoke", async (_e, params: RuntimeInvokeParams): Promise<RuntimeReceipt> => {
    if (!params?.agentId) throw new Error("agentId is required");
    if (typeof params.input !== "string") throw new Error("input is required");
    const chain = resolveChain(params.chain);

    const meteredInput: Parameters<typeof invokeAndMeter>[0] = {
      chain,
      agentId: params.agentId,
      input: params.input,
      license: params.license as never,
      dropId: params.dropId,
      buyer: params.buyer,
    };

    if (params.submitFeedback) {
      if (!params.clientId) {
        throw new Error("clientId is required when submitFeedback is true");
      }
      // GlueChainId and Erc8004ChainId share the same chain keys.
      const feedbackChain = chain as Erc8004ChainId;
      const wallet = await loadWallet(feedbackChain);
      meteredInput.feedback = {
        wallet,
        chain: feedbackChain,
        clientId: params.clientId,
        serverId: params.agentId,
        score: params.feedbackScore,
        feedbackUri: params.feedbackUri,
      };
    }

    const receipt = await invokeAndMeter(meteredInput);
    logger.info(
      `runtime:invoke agent=${receipt.agentId} ${receipt.durationMs}ms ` +
        `feedback=${receipt.feedbackTxHash ?? "none"}`,
    );
    return receipt;
  });

  ipcMain.handle(
    "runtime:bridge-a2a",
    async (_e, params: RuntimeBridgeA2aParams): Promise<BridgeResult> => {
      if (!params?.erc8004AgentId) throw new Error("erc8004AgentId is required");
      if (!Number.isInteger(params.localAgentId) || params.localAgentId <= 0) {
        throw new Error("localAgentId must be a positive integer");
      }
      const chain = resolveChain(params.chain);

      // Resolve the on-chain controller address (mirrored into the principal's
      // payout wallet) and, best-effort, the agent's current skill CID.
      const agent = await getAgent(chain as Erc8004ChainId, params.erc8004AgentId);
      let skillCid: string | undefined;
      try {
        skillCid = (await resolveSkill(chain, params.erc8004AgentId)).skillCid;
      } catch (err) {
        logger.warn(`could not resolve skillCid for agent ${params.erc8004AgentId}: ${(err as Error).message}`);
      }

      const result = await bridgeIdentityToA2a({
        localAgentId: params.localAgentId,
        erc8004AgentId: params.erc8004AgentId,
        chain,
        agentAddress: agent.agentAddress,
        skillCid,
        listingName: params.listingName,
        description: params.description,
        pricing: params.pricing,
      });
      logger.info(
        `runtime:bridge-a2a agent=${params.erc8004AgentId} → listing ${result.listingId} ` +
          `(created=${result.createdListing})`,
      );
      return result;
    },
  );
}
