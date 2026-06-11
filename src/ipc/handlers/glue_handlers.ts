/**
 * JOY Marketplace glue IPC handlers — wraps the StoreRegistry,
 * EditionController and AgentMandate Stylus contracts.
 *
 * Reads use a JsonRpcProvider; writes load the active secp256k1 key from
 * jcnKeyManager and sign locally. All handlers throw on failure per repo
 * convention.
 *
 * Channels registered here MUST also be added to:
 *   - src/ipc/ipc_host.ts (registerGlueHandlers)
 *   - src/preload.ts allowlist
 *   - src/ipc/ipc_client.ts (renderer-side methods)
 */

import { ipcMain } from "electron";
import { ethers } from "ethers";
import log from "electron-log";

import { jcnKeyManager } from "@/lib/jcn_key_manager";
import {
  DEFAULT_GLUE_CHAIN,
  GLUE_RPC,
  type GlueChainId,
  isGlueReady,
} from "@/config/glue";
import {
  canSpend,
  createDrop,
  createMandate,
  dropCount,
  editionBalanceOf,
  getDrop,
  getMandate,
  getStore,
  grantProof,
  isMandateValid,
  mandateCount,
  mintEdition,
  recordSpend,
  registerStore,
  resolveStoreBySlug,
  revokeMandate,
  setDropActive,
  setStoreAgent,
  storeCount,
  transferStore,
} from "@/lib/onchain/glue_client";
import {
  settleRegistrationFee,
  type RegistrationFeeResult,
} from "@/lib/x402/registration_fee";

const logger = log.scope("glue_handlers");

const SUPPORTED_CHAINS: readonly GlueChainId[] = ["arbitrumSepolia", "arbitrumOne"];

function resolveChain(value: unknown): GlueChainId {
  if (typeof value === "string" && (SUPPORTED_CHAINS as readonly string[]).includes(value)) {
    return value as GlueChainId;
  }
  if (value == null) return DEFAULT_GLUE_CHAIN;
  throw new Error(`chain must be one of ${SUPPORTED_CHAINS.join(", ")}, got ${String(value)}`);
}

async function loadWallet(chain: GlueChainId): Promise<ethers.Wallet> {
  await jcnKeyManager.initialize();
  const keys = await jcnKeyManager.listKeys("chain");
  const active = keys.find((k) => k.active && k.algorithm === "secp256k1");
  if (!active) {
    throw new Error("no active chain (secp256k1) key in jcnKeyManager — import one in Settings");
  }
  const pk = await jcnKeyManager.getPrivateKey(active.keyId);
  if (!pk) throw new Error("active chain key has no private material");
  const provider = new ethers.JsonRpcProvider(GLUE_RPC[chain]);
  const hex = pk.toString("hex");
  return new ethers.Wallet(hex.startsWith("0x") ? hex : `0x${hex}`, provider);
}

export function registerGlueHandlers(): void {
  // --- status -----------------------------------------------------------
  ipcMain.handle("glue:status", async (_e, params?: { chain?: string }) => {
    const chain = resolveChain(params?.chain);
    return { chain, ready: isGlueReady(chain) };
  });

  // --- StoreRegistry ----------------------------------------------------
  ipcMain.handle(
    "glue:register-store",
    async (
      _e,
      params: { chain?: string; slug: string; agentId?: string; payFee?: boolean },
    ) => {
      const chain = resolveChain(params?.chain);
      if (!params?.slug) throw new Error("slug is required");
      const wallet = await loadWallet(chain);
      // LR6 / G4: charge the x402 store-registration fee before registering.
      // Settlement throws on failure so a fee-ready chain never registers free.
      let registrationFee: RegistrationFeeResult | undefined;
      if (params.payFee) {
        registrationFee = await settleRegistrationFee(wallet, {
          chain,
          slug: params.slug,
        });
      }
      const result = await registerStore(wallet, {
        chain,
        slug: params.slug,
        agentId: params.agentId ?? "0",
      });
      logger.info(`registered store ${result.storeId} (${params.slug})`);
      return { ...result, registrationFee };
    },
  );

  ipcMain.handle(
    "glue:set-store-agent",
    async (_e, params: { chain?: string; storeId: string; agentId: string }) => {
      const chain = resolveChain(params?.chain);
      if (!params?.storeId) throw new Error("storeId is required");
      if (params?.agentId == null) throw new Error("agentId is required");
      const wallet = await loadWallet(chain);
      return setStoreAgent(wallet, { chain, storeId: params.storeId, agentId: params.agentId });
    },
  );

  ipcMain.handle(
    "glue:transfer-store",
    async (_e, params: { chain?: string; storeId: string; newOwner: string }) => {
      const chain = resolveChain(params?.chain);
      if (!params?.storeId) throw new Error("storeId is required");
      if (!params?.newOwner) throw new Error("newOwner is required");
      const wallet = await loadWallet(chain);
      return transferStore(wallet, { chain, storeId: params.storeId, newOwner: params.newOwner });
    },
  );

  ipcMain.handle(
    "glue:get-store",
    async (_e, params: { chain?: string; storeId: string }) => {
      const chain = resolveChain(params?.chain);
      if (!params?.storeId) throw new Error("storeId is required");
      return getStore(chain, params.storeId);
    },
  );

  ipcMain.handle(
    "glue:resolve-store-by-slug",
    async (_e, params: { chain?: string; slug: string }) => {
      const chain = resolveChain(params?.chain);
      if (!params?.slug) throw new Error("slug is required");
      const storeId = await resolveStoreBySlug(chain, params.slug);
      return { storeId };
    },
  );

  ipcMain.handle("glue:store-count", async (_e, params?: { chain?: string }) => {
    const chain = resolveChain(params?.chain);
    return { total: await storeCount(chain) };
  });

  // --- EditionController -------------------------------------------------
  ipcMain.handle(
    "glue:create-drop",
    async (
      _e,
      params: {
        chain?: string;
        storeId: string;
        assetLeaf: string;
        price?: string;
        maxSupply?: string;
        requiresProof?: boolean;
      },
    ) => {
      const chain = resolveChain(params?.chain);
      if (params?.storeId == null) throw new Error("storeId is required");
      if (!params?.assetLeaf) throw new Error("assetLeaf is required");
      const wallet = await loadWallet(chain);
      const result = await createDrop(wallet, {
        chain,
        storeId: params.storeId,
        assetLeaf: params.assetLeaf,
        price: params.price,
        maxSupply: params.maxSupply,
        requiresProof: params.requiresProof,
      });
      logger.info(`created drop ${result.dropId} (store ${params.storeId})`);
      return result;
    },
  );

  ipcMain.handle(
    "glue:set-drop-active",
    async (_e, params: { chain?: string; dropId: string; active: boolean }) => {
      const chain = resolveChain(params?.chain);
      if (params?.dropId == null) throw new Error("dropId is required");
      if (typeof params?.active !== "boolean") throw new Error("active must be a boolean");
      const wallet = await loadWallet(chain);
      return setDropActive(wallet, { chain, dropId: params.dropId, active: params.active });
    },
  );

  ipcMain.handle(
    "glue:grant-proof",
    async (_e, params: { chain?: string; dropId: string; account: string }) => {
      const chain = resolveChain(params?.chain);
      if (params?.dropId == null) throw new Error("dropId is required");
      if (!params?.account) throw new Error("account is required");
      const wallet = await loadWallet(chain);
      return grantProof(wallet, { chain, dropId: params.dropId, account: params.account });
    },
  );

  ipcMain.handle(
    "glue:mint",
    async (_e, params: { chain?: string; dropId: string }) => {
      const chain = resolveChain(params?.chain);
      if (params?.dropId == null) throw new Error("dropId is required");
      const wallet = await loadWallet(chain);
      const result = await mintEdition(wallet, { chain, dropId: params.dropId });
      logger.info(`minted token ${result.tokenId} from drop ${params.dropId}`);
      return result;
    },
  );

  ipcMain.handle(
    "glue:get-drop",
    async (_e, params: { chain?: string; dropId: string }) => {
      const chain = resolveChain(params?.chain);
      if (params?.dropId == null) throw new Error("dropId is required");
      return getDrop(chain, params.dropId);
    },
  );

  ipcMain.handle(
    "glue:edition-balance",
    async (_e, params: { chain?: string; dropId: string; account: string }) => {
      const chain = resolveChain(params?.chain);
      if (params?.dropId == null) throw new Error("dropId is required");
      if (!params?.account) throw new Error("account is required");
      const balance = await editionBalanceOf(chain, params.dropId, params.account);
      return { balance };
    },
  );

  ipcMain.handle("glue:drop-count", async (_e, params?: { chain?: string }) => {
    const chain = resolveChain(params?.chain);
    return { total: await dropCount(chain) };
  });

  // --- AgentMandate ------------------------------------------------------
  ipcMain.handle(
    "glue:create-mandate",
    async (
      _e,
      params: {
        chain?: string;
        agent: string;
        spendLimit: string;
        expiry?: string;
        actionScope?: string;
      },
    ) => {
      const chain = resolveChain(params?.chain);
      if (!params?.agent) throw new Error("agent is required");
      if (params?.spendLimit == null) throw new Error("spendLimit is required");
      const wallet = await loadWallet(chain);
      const result = await createMandate(wallet, {
        chain,
        agent: params.agent,
        spendLimit: params.spendLimit,
        expiry: params.expiry,
        actionScope: params.actionScope,
      });
      logger.info(`created mandate ${result.mandateId} for agent ${params.agent}`);
      return result;
    },
  );

  ipcMain.handle(
    "glue:record-spend",
    async (_e, params: { chain?: string; mandateId: string; amount: string }) => {
      const chain = resolveChain(params?.chain);
      if (params?.mandateId == null) throw new Error("mandateId is required");
      if (params?.amount == null) throw new Error("amount is required");
      const wallet = await loadWallet(chain);
      return recordSpend(wallet, { chain, mandateId: params.mandateId, amount: params.amount });
    },
  );

  ipcMain.handle(
    "glue:revoke-mandate",
    async (_e, params: { chain?: string; mandateId: string }) => {
      const chain = resolveChain(params?.chain);
      if (params?.mandateId == null) throw new Error("mandateId is required");
      const wallet = await loadWallet(chain);
      return revokeMandate(wallet, { chain, mandateId: params.mandateId });
    },
  );

  ipcMain.handle(
    "glue:is-mandate-valid",
    async (_e, params: { chain?: string; mandateId: string }) => {
      const chain = resolveChain(params?.chain);
      if (params?.mandateId == null) throw new Error("mandateId is required");
      const valid = await isMandateValid(chain, params.mandateId);
      return { valid };
    },
  );

  ipcMain.handle(
    "glue:can-spend",
    async (_e, params: { chain?: string; mandateId: string; amount: string }) => {
      const chain = resolveChain(params?.chain);
      if (params?.mandateId == null) throw new Error("mandateId is required");
      if (params?.amount == null) throw new Error("amount is required");
      const allowed = await canSpend(chain, params.mandateId, params.amount);
      return { allowed };
    },
  );

  ipcMain.handle(
    "glue:get-mandate",
    async (_e, params: { chain?: string; mandateId: string }) => {
      const chain = resolveChain(params?.chain);
      if (params?.mandateId == null) throw new Error("mandateId is required");
      return getMandate(chain, params.mandateId);
    },
  );

  ipcMain.handle("glue:mandate-count", async (_e, params?: { chain?: string }) => {
    const chain = resolveChain(params?.chain);
    return { total: await mandateCount(chain) };
  });
}
