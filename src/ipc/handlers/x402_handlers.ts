/**
 * X402 pay-per-prompt IPC handlers — wraps the facilitator (server) and the
 * payer (client) sides of the x402 "exact" scheme over USDC.
 *
 * Reads use a JsonRpcProvider; payment signing and settlement load the active
 * secp256k1 key from jcnKeyManager and sign locally. All handlers throw on
 * failure per repo convention.
 *
 * Channels registered here MUST also be added to:
 *   - src/ipc/ipc_host.ts (registerX402Handlers)
 *   - src/preload.ts allowlist
 *   - src/ipc/ipc_client.ts (renderer-side methods)
 */

import { ipcMain } from "electron";
import { ethers } from "ethers";
import log from "electron-log";

import { jcnKeyManager } from "@/lib/jcn_key_manager";
import {
  DEFAULT_X402_CHAIN,
  X402_RPC,
  isX402Ready,
  usdcToAtomic,
  atomicToUsdc,
  type X402ChainId,
} from "@/config/x402";
import { createPayment } from "@/lib/x402/client";
import {
  createPaymentRequirements,
  getCreatorEarnings,
  settlePayment,
  verifyPayment,
} from "@/lib/x402/server";
import { purchaseEdition, purchaseEditionWithMandate } from "@/lib/x402/purchase_orchestrator";
import type { PaymentPayload, PaymentRequirements } from "@/lib/x402/types";

const logger = log.scope("x402_handlers");

const SUPPORTED_CHAINS: readonly X402ChainId[] = ["arbitrumSepolia", "arbitrumOne"];

function resolveChain(value: unknown): X402ChainId {
  if (typeof value === "string" && (SUPPORTED_CHAINS as readonly string[]).includes(value)) {
    return value as X402ChainId;
  }
  if (value == null) return DEFAULT_X402_CHAIN;
  throw new Error(`chain must be one of ${SUPPORTED_CHAINS.join(", ")}, got ${String(value)}`);
}

async function loadWallet(chain: X402ChainId): Promise<ethers.Wallet> {
  await jcnKeyManager.initialize();
  const keys = await jcnKeyManager.listKeys("chain");
  const active = keys.find((k) => k.active && k.algorithm === "secp256k1");
  if (!active) {
    throw new Error("no active chain (secp256k1) key in jcnKeyManager — import one in Settings");
  }
  const pk = await jcnKeyManager.getPrivateKey(active.keyId);
  if (!pk) throw new Error("active chain key has no private material");
  const provider = new ethers.JsonRpcProvider(X402_RPC[chain]);
  const hex = pk.toString("hex");
  return new ethers.Wallet(hex.startsWith("0x") ? hex : `0x${hex}`, provider);
}

/** Resolve an atomic amount from either `amountAtomic` or human `amountUsdc`. */
function resolveAmount(params: { amountAtomic?: string; amountUsdc?: string }): string {
  if (params.amountAtomic) return BigInt(params.amountAtomic).toString();
  if (params.amountUsdc) return usdcToAtomic(params.amountUsdc).toString();
  throw new Error("amountAtomic or amountUsdc is required");
}

export function registerX402Handlers(): void {
  // --- status -----------------------------------------------------------
  ipcMain.handle("x402:status", async (_e, params?: { chain?: string }) => {
    const chain = resolveChain(params?.chain);
    return { chain, ready: isX402Ready(chain) };
  });

  // --- challenge: build PaymentRequirements (402) -----------------------
  ipcMain.handle(
    "x402:create-challenge",
    async (
      _e,
      params: {
        chain?: string;
        amountAtomic?: string;
        amountUsdc?: string;
        resource: string;
        description: string;
        mimeType?: string;
        maxTimeoutSeconds?: number;
      },
    ) => {
      const chain = resolveChain(params?.chain);
      if (!params?.resource) throw new Error("resource is required");
      if (!params?.description) throw new Error("description is required");
      const amountAtomic = resolveAmount(params);
      const requirements = createPaymentRequirements({
        chain,
        amountAtomic,
        resource: params.resource,
        description: params.description,
        mimeType: params.mimeType,
        maxTimeoutSeconds: params.maxTimeoutSeconds,
      });
      logger.info(`x402 challenge: ${atomicToUsdc(amountAtomic)} USDC for ${params.resource}`);
      return requirements;
    },
  );

  // --- pay: sign an EIP-3009 authorization (payer side) -----------------
  ipcMain.handle(
    "x402:create-payment",
    async (_e, params: { chain?: string; requirements: PaymentRequirements }) => {
      const chain = resolveChain(params?.chain);
      if (!params?.requirements) throw new Error("requirements is required");
      const wallet = await loadWallet(chain);
      const { payload, header } = await createPayment(wallet, params.requirements);
      return { payload, header, payer: wallet.address };
    },
  );

  // --- verify: check a payment without settling -------------------------
  ipcMain.handle(
    "x402:verify-payment",
    async (
      _e,
      params: { payment: PaymentPayload; requirements: PaymentRequirements },
    ) => {
      if (!params?.payment) throw new Error("payment is required");
      if (!params?.requirements) throw new Error("requirements is required");
      return verifyPayment(params.payment, params.requirements);
    },
  );

  // --- settle: submit transferWithAuthorization + 80/10/10 distribute ---
  ipcMain.handle(
    "x402:settle",
    async (
      _e,
      params: {
        chain?: string;
        payment: PaymentPayload;
        requirements: PaymentRequirements;
        creator: string;
      },
    ) => {
      const chain = resolveChain(params?.chain);
      if (!params?.payment) throw new Error("payment is required");
      if (!params?.requirements) throw new Error("requirements is required");
      if (!params?.creator) throw new Error("creator is required");
      const facilitator = await loadWallet(chain);
      const result = await settlePayment({
        facilitator,
        payment: params.payment,
        requirements: params.requirements,
        creator: params.creator,
      });
      if (!result.success) {
        throw new Error(result.error ?? "settlement failed");
      }
      return result;
    },
  );

  // --- creator earnings -------------------------------------------------
  ipcMain.handle(
    "x402:creator-earnings",
    async (_e, params: { chain?: string; creator: string }) => {
      const chain = resolveChain(params?.chain);
      if (!params?.creator) throw new Error("creator is required");
      return getCreatorEarnings(chain, params.creator);
    },
  );

  // --- purchase: end-to-end pay-per-mint of an EditionController drop ----
  ipcMain.handle(
    "x402:purchase-edition",
    async (_e, params: { chain?: string; dropId: string }) => {
      const chain = resolveChain(params?.chain);
      if (!params?.dropId) throw new Error("dropId is required");
      const wallet = await loadWallet(chain);
      return purchaseEdition(wallet, { chain, dropId: params.dropId });
    },
  );

  // --- purchase as an agent under an on-chain AgentMandate (LR4) ---------
  ipcMain.handle(
    "x402:purchase-edition-with-mandate",
    async (
      _e,
      params: { chain?: string; dropId: string; mandateId: string; feedbackScore?: number },
    ) => {
      const chain = resolveChain(params?.chain);
      if (!params?.dropId) throw new Error("dropId is required");
      if (params?.mandateId == null) throw new Error("mandateId is required");
      const wallet = await loadWallet(chain);
      return purchaseEditionWithMandate(wallet, {
        chain,
        dropId: params.dropId,
        mandateId: params.mandateId,
        feedbackScore: params.feedbackScore,
      });
    },
  );
}
