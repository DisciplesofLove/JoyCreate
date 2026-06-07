/**
 * DatasetMonetizationOrchestrator — the dataset-specific wrapper over the
 * generic `publishAndMonetize` bridge.
 *
 * Delegates the publish → store → EditionController drop → ERC-1144 blueprint
 * pipeline to `publishAndMonetize`, then maps the outcome into the dataset's
 * `DataMonetization` record (marketplaceListingId, nftTokenId, x402DropId, …)
 * so it can be persisted and later purchased via `purchaseEdition({ chain,
 * dropId })`.
 *
 * Like `publishAndMonetize`, this NEVER throws — every failure is captured into
 * `errors`.
 */

import { getEditionControllerAddress, isGlueReady } from "@/config/glue";
import { type X402ChainId } from "@/config/x402";
import { publishAndMonetize } from "./publish_and_monetize";
import type { PublishInput, PublishOutcome } from "./publish_orchestrator";
import type { DataMonetization, MonetizationLicense } from "@/types/data_sovereignty_types";

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

/**
 * Publish a dataset to the marketplace AND create an EditionController drop so
 * the listing is purchasable through the x402 pay-per-mint rail. Delegates the
 * heavy lifting to `publishAndMonetize` and maps the result into the dataset's
 * `DataMonetization` record.
 */
export async function monetizeDataset(
  input: MonetizeDatasetInput,
): Promise<MonetizeDatasetOutcome> {
  const royaltyBps = input.royaltyBps ?? 250;

  const result = await publishAndMonetize({
    publish: input.publish,
    chain: input.chain,
    storeSlug: input.storeSlug,
    priceUsdc: input.priceUsdc,
    royaltyBps,
    maxSupply: input.maxSupply,
    requiresProof: input.requiresProof,
    assetLeafSource: input.assetLeafSource,
    dryRun: input.dryRun,
  });

  const publish = result.publish;
  const dropChain = result.chain;

  const monetization: DataMonetization = {
    enabled: publish.ok,
    pricingModel: "per-use",
    price: input.priceUsdc,
    currency: "USDC",
    royaltyPercent: royaltyBps / 100,
    marketplaceListingId: publish.listingId,
    marketplaceUrl: publish.marketplaceUrl,
    nftTokenId: publish.tokenId,
    nftContractAddress:
      dropChain && isGlueReady(dropChain) ? getEditionControllerAddress(dropChain) : undefined,
    x402DropId: result.dropId,
    x402ChainId: result.dropId && dropChain ? dropChain : undefined,
    totalRevenue: 0,
    totalPurchases: 0,
    license: input.license,
  };

  return {
    ok: result.ok,
    dryRun: result.dryRun,
    publish,
    dropId: result.dropId,
    dropTxHash: result.dropTxHash,
    monetization,
    errors: result.errors,
  };
}
