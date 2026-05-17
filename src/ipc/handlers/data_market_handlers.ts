/**
 * Data Market IPC handlers — wraps DataProvenance + DataLease Stylus contracts.
 *
 * Reads use a JsonRpcProvider; writes load the active secp256k1 key from
 * jcnKeyManager and sign locally. All handlers throw on failure per repo
 * convention.
 *
 * Channels registered here MUST also be added to:
 *   - src/preload.ts allowlist
 *   - src/ipc/ipc_client.ts (renderer-side method)
 */

import { ipcMain } from "electron";
import { ethers } from "ethers";
import log from "electron-log";
import { eq, desc, and } from "drizzle-orm";
import { db } from "@/db";
import {
  dataProvenanceTokens,
  dataLeaseListings,
  dataLeaseGrants,
} from "@/db/schema";
import { jcnKeyManager } from "@/lib/jcn_key_manager";
import {
  DATA_MARKET_RPC,
  type DataMarketChainId,
  getLeaseAddress,
  getProvenanceAddress,
  isDataMarketReady,
} from "@/config/data_market";
import {
  createListing,
  hasActiveLease,
  mintProvenance,
  purchaseLease,
  readListing,
  readProvenance,
  type CreateListingInput,
  type MintProvenanceInput,
  type PurchaseLeaseInput,
} from "@/lib/onchain/data_market_client";

const logger = log.scope("data_market_handlers");

const SUPPORTED_CHAINS: readonly DataMarketChainId[] = [
  "arbitrumSepolia",
  "arbitrumOne",
];

function isSupportedChain(value: unknown): value is DataMarketChainId {
  return typeof value === "string" && (SUPPORTED_CHAINS as readonly string[]).includes(value);
}

function requireChain(value: unknown): DataMarketChainId {
  if (!isSupportedChain(value)) {
    throw new Error(
      `chain must be one of ${SUPPORTED_CHAINS.join(", ")}, got ${String(value)}`,
    );
  }
  return value;
}

async function loadWallet(chain: DataMarketChainId): Promise<ethers.Wallet> {
  await jcnKeyManager.initialize();
  const keys = await jcnKeyManager.listKeys("chain");
  const active = keys.find((k) => k.active && k.algorithm === "secp256k1");
  if (!active) {
    throw new Error(
      "no active chain (secp256k1) key in jcnKeyManager — import one in Settings",
    );
  }
  const pk = await jcnKeyManager.getPrivateKey(active.keyId);
  if (!pk) throw new Error("active chain key has no private material");
  const provider = new ethers.JsonRpcProvider(DATA_MARKET_RPC[chain]);
  const hex = pk.toString("hex");
  const prefixed = hex.startsWith("0x") ? hex : `0x${hex}`;
  return new ethers.Wallet(prefixed, provider);
}

// ---------------------------------------------------------------------------
// Mirror writes to local SQLite. These are idempotent on (txHash, *).
// ---------------------------------------------------------------------------

async function mirrorProvenanceMint(args: {
  chain: DataMarketChainId;
  tokenId: string;
  creator: string;
  merkleRoot: string;
  contentUri: string;
  humanProof: string;
  mintedAtChain: string;
  txHash: string;
}): Promise<void> {
  try {
    await db.insert(dataProvenanceTokens).values({
      chainId: args.chain,
      contractAddress: getProvenanceAddress(args.chain),
      tokenId: args.tokenId,
      creator: args.creator,
      merkleRoot: args.merkleRoot,
      contentUri: args.contentUri,
      humanProof: args.humanProof,
      mintedAtChain: args.mintedAtChain,
      txHash: args.txHash,
    });
  } catch (err) {
    logger.warn("mirrorProvenanceMint insert failed", err);
  }
}

async function mirrorListingCreate(args: {
  chain: DataMarketChainId;
  listingId: string;
  tokenId: string;
  creator: string;
  priceWei: string;
  durationSecs: string;
  accConditionsHash: string;
  txHash: string;
}): Promise<void> {
  try {
    await db.insert(dataLeaseListings).values({
      chainId: args.chain,
      contractAddress: getLeaseAddress(args.chain),
      listingId: args.listingId,
      tokenId: args.tokenId,
      creator: args.creator,
      priceWei: args.priceWei,
      durationSecs: args.durationSecs,
      accConditionsHash: args.accConditionsHash,
      active: true,
      createdTxHash: args.txHash,
    });
  } catch (err) {
    logger.warn("mirrorListingCreate insert failed", err);
  }
}

async function mirrorLeaseGrant(args: {
  chain: DataMarketChainId;
  leaseId: string;
  listingId: string;
  tokenId: string;
  lessee: string;
  paidWei: string;
  expiresAt: string;
  accConditionsHash: string;
  txHash: string;
}): Promise<void> {
  try {
    await db.insert(dataLeaseGrants).values({
      chainId: args.chain,
      contractAddress: getLeaseAddress(args.chain),
      leaseId: args.leaseId,
      listingId: args.listingId,
      tokenId: args.tokenId,
      lessee: args.lessee,
      paidWei: args.paidWei,
      expiresAt: args.expiresAt,
      accConditionsHash: args.accConditionsHash,
      relayerStatus: "pending",
      grantedTxHash: args.txHash,
    });
  } catch (err) {
    logger.warn("mirrorLeaseGrant insert failed", err);
  }
}

// ---------------------------------------------------------------------------
// Handler registration
// ---------------------------------------------------------------------------

export function registerDataMarketHandlers(): void {
  ipcMain.handle("data-market:status", async (_e, raw: { chain: string }) => {
    const chain = requireChain(raw?.chain);
    return {
      chain,
      ready: isDataMarketReady(chain),
      provenanceAddress: getProvenanceAddress(chain),
      leaseAddress: getLeaseAddress(chain),
      rpcUrl: DATA_MARKET_RPC[chain],
    };
  });

  // --- Provenance ----------------------------------------------------------

  ipcMain.handle(
    "data-provenance:mint",
    async (_e, raw: { chain: string } & Omit<MintProvenanceInput, "chain">) => {
      const chain = requireChain(raw?.chain);
      const wallet = await loadWallet(chain);
      const result = await mintProvenance(wallet, {
        chain,
        merkleRoot: raw.merkleRoot,
        contentUri: raw.contentUri,
        humanProof: raw.humanProof,
      });
      await mirrorProvenanceMint({
        chain,
        tokenId: result.tokenId,
        creator: result.creator,
        merkleRoot: raw.merkleRoot,
        contentUri: raw.contentUri,
        humanProof: raw.humanProof,
        mintedAtChain: result.mintedAtChain,
        txHash: result.txHash,
      });
      return result;
    },
  );

  ipcMain.handle(
    "data-provenance:get",
    async (_e, raw: { chain: string; tokenId: string }) => {
      const chain = requireChain(raw?.chain);
      if (!raw?.tokenId) throw new Error("tokenId is required");
      return readProvenance(chain, raw.tokenId);
    },
  );

  ipcMain.handle(
    "data-provenance:list",
    async (_e, raw?: { chain?: string; creator?: string; limit?: number }) => {
      const limit = Math.min(Math.max(raw?.limit ?? 50, 1), 200);
      const filters = [];
      if (raw?.chain && isSupportedChain(raw.chain)) {
        filters.push(eq(dataProvenanceTokens.chainId, raw.chain));
      }
      if (raw?.creator && ethers.isAddress(raw.creator)) {
        filters.push(eq(dataProvenanceTokens.creator, raw.creator));
      }
      const whereExpr = filters.length === 0 ? undefined : filters.length === 1 ? filters[0] : and(...filters);
      const rows = await db
        .select()
        .from(dataProvenanceTokens)
        .where(whereExpr)
        .orderBy(desc(dataProvenanceTokens.observedAt))
        .limit(limit);
      return rows;
    },
  );

  // --- Lease listings ------------------------------------------------------

  ipcMain.handle(
    "data-lease:create-listing",
    async (_e, raw: { chain: string } & Omit<CreateListingInput, "chain">) => {
      const chain = requireChain(raw?.chain);
      const wallet = await loadWallet(chain);
      const result = await createListing(wallet, {
        chain,
        tokenId: raw.tokenId,
        priceWei: raw.priceWei,
        durationSecs: raw.durationSecs,
        accConditionsHash: raw.accConditionsHash,
      });
      await mirrorListingCreate({
        chain,
        listingId: result.listingId,
        tokenId: raw.tokenId,
        creator: wallet.address,
        priceWei: raw.priceWei,
        durationSecs: raw.durationSecs,
        accConditionsHash: raw.accConditionsHash,
        txHash: result.txHash,
      });
      return result;
    },
  );

  ipcMain.handle(
    "data-lease:get-listing",
    async (_e, raw: { chain: string; listingId: string }) => {
      const chain = requireChain(raw?.chain);
      if (!raw?.listingId) throw new Error("listingId is required");
      return readListing(chain, raw.listingId);
    },
  );

  ipcMain.handle(
    "data-lease:list-listings",
    async (_e, raw?: { chain?: string; creator?: string; activeOnly?: boolean; limit?: number }) => {
      const limit = Math.min(Math.max(raw?.limit ?? 50, 1), 200);
      const filters = [];
      if (raw?.chain && isSupportedChain(raw.chain)) {
        filters.push(eq(dataLeaseListings.chainId, raw.chain));
      }
      if (raw?.creator && ethers.isAddress(raw.creator)) {
        filters.push(eq(dataLeaseListings.creator, raw.creator));
      }
      if (raw?.activeOnly) {
        filters.push(eq(dataLeaseListings.active, true));
      }
      const whereExpr = filters.length === 0 ? undefined : filters.length === 1 ? filters[0] : and(...filters);
      const rows = await db
        .select()
        .from(dataLeaseListings)
        .where(whereExpr)
        .orderBy(desc(dataLeaseListings.observedAt))
        .limit(limit);
      return rows;
    },
  );

  // --- Lease purchase ------------------------------------------------------

  ipcMain.handle(
    "data-lease:purchase",
    async (_e, raw: { chain: string } & Omit<PurchaseLeaseInput, "chain">) => {
      const chain = requireChain(raw?.chain);
      const wallet = await loadWallet(chain);
      const result = await purchaseLease(wallet, {
        chain,
        listingId: raw.listingId,
        priceWei: raw.priceWei,
      });
      await mirrorLeaseGrant({
        chain,
        leaseId: result.leaseId,
        listingId: result.listingId,
        tokenId: result.tokenId,
        lessee: result.lessee,
        paidWei: raw.priceWei,
        expiresAt: result.expiresAt,
        accConditionsHash: result.accConditionsHash,
        txHash: result.txHash,
      });
      return result;
    },
  );

  ipcMain.handle(
    "data-lease:list-my-grants",
    async (_e, raw?: { chain?: string; lessee?: string; limit?: number }) => {
      const limit = Math.min(Math.max(raw?.limit ?? 50, 1), 200);
      const filters = [];
      if (raw?.chain && isSupportedChain(raw.chain)) {
        filters.push(eq(dataLeaseGrants.chainId, raw.chain));
      }
      if (raw?.lessee && ethers.isAddress(raw.lessee)) {
        filters.push(eq(dataLeaseGrants.lessee, raw.lessee));
      }
      const whereExpr = filters.length === 0 ? undefined : filters.length === 1 ? filters[0] : and(...filters);
      const rows = await db
        .select()
        .from(dataLeaseGrants)
        .where(whereExpr)
        .orderBy(desc(dataLeaseGrants.observedAt))
        .limit(limit);
      return rows;
    },
  );

  ipcMain.handle(
    "data-lease:has-active",
    async (_e, raw: { chain: string; listingId: string; lessee: string }) => {
      const chain = requireChain(raw?.chain);
      if (!raw?.listingId) throw new Error("listingId is required");
      if (!raw?.lessee) throw new Error("lessee is required");
      return hasActiveLease(chain, raw.listingId, raw.lessee);
    },
  );

  logger.info("data-market handlers registered");
}
