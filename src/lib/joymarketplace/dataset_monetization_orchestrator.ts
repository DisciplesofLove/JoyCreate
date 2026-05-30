/**
 * DatasetMonetizationOrchestrator — the missing JOIN between a published
 * marketplace dataset and an x402-purchasable EditionController drop.
 *
 * Pipeline:
 *   1. publishAndForget(...)            -> ERC-1155 mint + marketplace listing.
 *   2. resolveStoreBySlug + createDrop  -> on-chain drop the x402 rail mints.
 *   3. assemble + return DataMonetization (marketplaceListingId, nftTokenId,
 *      x402DropId, ...) so the dataset record can be persisted and later
 *      purchased via `purchaseEdition({ chain, dropId })`.
 *
 * Like `publishAndForget`, this NEVER throws — every failure is captured into
 * `errors`. The marketplace publish and the on-chain drop are independent: a
 * dataset can be listed even if the drop cannot be created (e.g. no registered
 * store), in which case `x402DropId` is left undefined.
 */

import log from "electron-log";
import { ethers } from "ethers";

import { jcnKeyManager } from "@/lib/jcn_key_manager";
import {
  GLUE_RPC,
  getEditionControllerAddress,
  isGlueReady,
  type GlueChainId,
} from "@/config/glue";
import { usdcToAtomic, type X402ChainId } from "@/config/x402";
import { createDrop, resolveStoreBySlug } from "@/lib/onchain/glue_client";
import { publishAndForget, type PublishInput, type PublishOutcome } from "./publish_orchestrator";
import type { DataMonetization, MonetizationLicense } from "@/types/data_sovereignty_types";

const logger = log.scope("dataset_monetization");

export interface MonetizeDatasetInput {
  /** Forwarded verbatim to publishAndForget (mint + listing). */
  publish: PublishInput;
  /** Chain used for both the marketplace context and the EditionController drop. */
  chain: X402ChainId;
  /** EditionController store slug the drop is created under. */
  storeSlug: string;
  /**
   * 0x-prefixed 32-byte merkle root / manifest hash committed by the drop.
   * When not already a 32-byte hex value it is keccak256-hashed.
   */
  assetLeafSource?: string | null;
  /** Human-readable USDC price (e.g. 1.5). Also drives the drop price. */
  priceUsdc: number;
  /** EIP-2981 royalty in basis points. Default 250 (2.5%). */
  royaltyBps?: number;
  /** Max editions; 0 = unlimited. Default 0. */
  maxSupply?: number;
  /** Require proof-of-use before mint. Default false. */
  requiresProof?: boolean;
  /** License terms recorded on the monetization record. */
  license: MonetizationLicense;
  /** When true, pin/estimate only — no on-chain writes. */
  dryRun?: boolean;
}

export interface MonetizeDatasetOutcome {
  ok: boolean;
  dryRun: boolean;
  publish: PublishOutcome;
  dropId?: string;
  dropTxHash?: string;
  monetization: DataMonetization;
  errors: string[];
}

/** Load the active secp256k1 chain key as an ethers.Wallet bound to the glue RPC. */
async function loadGlueWallet(chain: GlueChainId): Promise<ethers.Wallet> {
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

/** Coerce an arbitrary source string into a 0x-prefixed 32-byte asset leaf. */
function toAssetLeaf(source: string | null | undefined, fallback: string): string {
  const candidate = source ?? fallback;
  if (/^0x[0-9a-fA-F]{64}$/.test(candidate)) return candidate;
  return ethers.keccak256(ethers.toUtf8Bytes(candidate));
}

/**
 * Publish a dataset to the marketplace AND create an EditionController drop so
 * the listing is purchasable through the x402 pay-per-mint rail.
 */
export async function monetizeDataset(
  input: MonetizeDatasetInput,
): Promise<MonetizeDatasetOutcome> {
  const errors: string[] = [];
  const royaltyBps = input.royaltyBps ?? 250;

  // priceUsdc is human (e.g. 1.5); both the listing and the drop want USDC
  // atomic base units (6 decimals).
  const priceAtomic = usdcToAtomic(String(input.priceUsdc));

  const publish = await publishAndForget({
    ...input.publish,
    priceUsdc: Number(priceAtomic),
    royaltyBps,
    storeSlug: input.publish.storeSlug ?? input.storeSlug,
    dryRun: input.dryRun,
  });
  if (publish.errors?.length) errors.push(...publish.errors);

  let dropId: string | undefined;
  let dropTxHash: string | undefined;

  // Create the on-chain drop only when the marketplace publish actually landed
  // on chain. A drop with no listing has nothing to point buyers at.
  if (publish.ok && !publish.dryRun) {
    try {
      if (!isGlueReady(input.chain)) {
        throw new Error(`EditionController not deployed on ${input.chain}`);
      }
      const wallet = await loadGlueWallet(input.chain);
      const storeId = await resolveStoreBySlug(input.chain, input.storeSlug);
      if (!storeId || storeId === "0") {
        throw new Error(`no EditionController store registered for slug "${input.storeSlug}"`);
      }
      const assetLeaf = toAssetLeaf(
        input.assetLeafSource ?? publish.merkleRoot ?? publish.contentHash,
        publish.contentCid ?? input.publish.name,
      );
      const drop = await createDrop(wallet, {
        chain: input.chain,
        storeId,
        assetLeaf,
        price: priceAtomic.toString(),
        maxSupply: String(input.maxSupply ?? 0),
        requiresProof: input.requiresProof ?? false,
      });
      dropId = drop.dropId;
      dropTxHash = drop.txHash;
      logger.info(`created x402 drop ${dropId} for dataset publish (token ${publish.tokenId})`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn("x402 drop creation failed:", message);
      errors.push(`x402-drop: ${message}`);
    }
  }

  const monetization: DataMonetization = {
    enabled: publish.ok,
    pricingModel: "per-use",
    price: input.priceUsdc,
    currency: "USDC",
    royaltyPercent: royaltyBps / 100,
    marketplaceListingId: publish.listingId,
    marketplaceUrl: publish.marketplaceUrl,
    nftTokenId: publish.tokenId,
    nftContractAddress: isGlueReady(input.chain)
      ? getEditionControllerAddress(input.chain)
      : undefined,
    x402DropId: dropId,
    x402ChainId: dropId ? input.chain : undefined,
    totalRevenue: 0,
    totalPurchases: 0,
    license: input.license,
  };

  return {
    ok: publish.ok,
    dryRun: publish.dryRun,
    publish,
    dropId,
    dropTxHash,
    monetization,
    errors,
  };
}
