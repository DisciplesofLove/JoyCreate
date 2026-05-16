/**
 * Thin ethers wrapper around the DataProvenance + DataLease Stylus contracts.
 * Used by the IPC handlers in `src/ipc/handlers/data_market_handlers.ts`.
 *
 * All writes require a signing `Wallet`. Reads only need a provider.
 */

import { ethers } from "ethers";
import log from "electron-log";
import {
  DATA_LEASE_ABI,
  DATA_PROVENANCE_ABI,
  DATA_MARKET_RPC,
  type DataMarketChainId,
  getLeaseAddress,
  getProvenanceAddress,
  isDataMarketReady,
  ZERO_ADDRESS,
} from "@/config/data_market";

const logger = log.scope("data_market_client");

function requireReady(chain: DataMarketChainId): void {
  if (!isDataMarketReady(chain)) {
    throw new Error(
      `data-market contracts not deployed on ${chain} — fill addresses in src/config/data_market.ts`,
    );
  }
}

export function makeProvider(chain: DataMarketChainId): ethers.JsonRpcProvider {
  return new ethers.JsonRpcProvider(DATA_MARKET_RPC[chain]);
}

export function makeProvenanceContract(
  chain: DataMarketChainId,
  signerOrProvider?: ethers.Signer | ethers.Provider,
): ethers.Contract {
  requireReady(chain);
  const addr = getProvenanceAddress(chain);
  return new ethers.Contract(
    addr,
    DATA_PROVENANCE_ABI as unknown as ethers.InterfaceAbi,
    signerOrProvider ?? makeProvider(chain),
  );
}

export function makeLeaseContract(
  chain: DataMarketChainId,
  signerOrProvider?: ethers.Signer | ethers.Provider,
): ethers.Contract {
  requireReady(chain);
  const addr = getLeaseAddress(chain);
  return new ethers.Contract(
    addr,
    DATA_LEASE_ABI as unknown as ethers.InterfaceAbi,
    signerOrProvider ?? makeProvider(chain),
  );
}

// ---------------------------------------------------------------------------
// Provenance writes / reads
// ---------------------------------------------------------------------------

export interface MintProvenanceInput {
  chain: DataMarketChainId;
  /** 0x-prefixed 32-byte IPLD merkle root. */
  merkleRoot: string;
  /** UTF-8 string; will be encoded as bytes. Pinata CID or lit-encrypted ref. */
  contentUri: string;
  /** 0x-prefixed 32-byte attestation digest (personhood proof). */
  humanProof: string;
}

export interface MintProvenanceResult {
  tokenId: string;
  txHash: string;
  blockNumber: number;
  creator: string;
  mintedAtChain: string;
}

function assertBytes32(label: string, value: string): void {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`${label} must be a 0x-prefixed 32-byte hex string`);
  }
}

export async function mintProvenance(
  wallet: ethers.Wallet,
  input: MintProvenanceInput,
): Promise<MintProvenanceResult> {
  assertBytes32("merkleRoot", input.merkleRoot);
  assertBytes32("humanProof", input.humanProof);
  if (!input.contentUri || input.contentUri.length === 0) {
    throw new Error("contentUri must be a non-empty string");
  }

  const contract = makeProvenanceContract(input.chain, wallet);
  const contentBytes = ethers.toUtf8Bytes(input.contentUri);
  const overrides = { maxFeePerGas: 200_000_000n, maxPriorityFeePerGas: 100_000n };

  const tx = await contract.mintProvenance(
    input.merkleRoot,
    contentBytes,
    input.humanProof,
    overrides,
  );
  logger.info("mintProvenance tx", tx.hash);
  const receipt = await tx.wait();
  if (!receipt) throw new Error("mintProvenance tx receipt was null");

  // Parse ProvenanceMinted to get tokenId + mintedAt.
  const iface = contract.interface;
  let tokenId = "";
  let mintedAt = "";
  for (const lg of receipt.logs ?? []) {
    try {
      const parsed = iface.parseLog({ topics: lg.topics as string[], data: lg.data });
      if (parsed?.name === "ProvenanceMinted") {
        tokenId = (parsed.args.tokenId as bigint).toString();
        mintedAt = (parsed.args.mintedAt as bigint).toString();
        break;
      }
    } catch {
      // not our event
    }
  }
  if (!tokenId) throw new Error("ProvenanceMinted event not found in receipt");

  return {
    tokenId,
    txHash: receipt.hash,
    blockNumber: receipt.blockNumber,
    creator: wallet.address,
    mintedAtChain: mintedAt,
  };
}

export interface ProvenanceRecord {
  tokenId: string;
  creator: string;
  merkleRoot: string;
  contentUri: string;
  humanProof: string;
  mintedAtChain: string;
}

export async function readProvenance(
  chain: DataMarketChainId,
  tokenId: string,
): Promise<ProvenanceRecord> {
  const contract = makeProvenanceContract(chain);
  const id = BigInt(tokenId);
  const [creator, merkleRoot, contentBytes, humanProof, mintedAt] = await Promise.all([
    contract.creatorOf(id),
    contract.merkleRootOf(id),
    contract.contentUriOf(id),
    contract.humanProofOf(id),
    contract.mintedAt(id),
  ]);
  return {
    tokenId,
    creator: creator as string,
    merkleRoot: merkleRoot as string,
    contentUri: ethers.toUtf8String(contentBytes as string),
    humanProof: humanProof as string,
    mintedAtChain: (mintedAt as bigint).toString(),
  };
}

// ---------------------------------------------------------------------------
// Lease writes / reads
// ---------------------------------------------------------------------------

export interface CreateListingInput {
  chain: DataMarketChainId;
  tokenId: string;
  priceWei: string;
  durationSecs: string;
  /** 0x-prefixed 32-byte Lit Protocol ACC digest. */
  accConditionsHash: string;
}

export interface CreateListingResult {
  listingId: string;
  txHash: string;
  blockNumber: number;
}

export async function createListing(
  wallet: ethers.Wallet,
  input: CreateListingInput,
): Promise<CreateListingResult> {
  assertBytes32("accConditionsHash", input.accConditionsHash);
  if (input.accConditionsHash === ethers.ZeroHash) {
    throw new Error("accConditionsHash must not be zero");
  }
  if (BigInt(input.priceWei) === 0n) throw new Error("priceWei must be > 0");
  if (BigInt(input.durationSecs) === 0n) throw new Error("durationSecs must be > 0");

  const contract = makeLeaseContract(input.chain, wallet);
  const overrides = { maxFeePerGas: 200_000_000n, maxPriorityFeePerGas: 100_000n };
  const tx = await contract.createListing(
    BigInt(input.tokenId),
    BigInt(input.priceWei),
    BigInt(input.durationSecs),
    input.accConditionsHash,
    overrides,
  );
  const receipt = await tx.wait();
  if (!receipt) throw new Error("createListing receipt null");

  const iface = contract.interface;
  let listingId = "";
  for (const lg of receipt.logs ?? []) {
    try {
      const parsed = iface.parseLog({ topics: lg.topics as string[], data: lg.data });
      if (parsed?.name === "ListingCreated") {
        listingId = (parsed.args.listingId as bigint).toString();
        break;
      }
    } catch {
      // ignore
    }
  }
  if (!listingId) throw new Error("ListingCreated event not found");
  return { listingId, txHash: receipt.hash, blockNumber: receipt.blockNumber };
}

export interface PurchaseLeaseInput {
  chain: DataMarketChainId;
  listingId: string;
  priceWei: string;
}

export interface PurchaseLeaseResult {
  leaseId: string;
  listingId: string;
  lessee: string;
  tokenId: string;
  expiresAt: string;
  accConditionsHash: string;
  txHash: string;
  blockNumber: number;
}

export async function purchaseLease(
  wallet: ethers.Wallet,
  input: PurchaseLeaseInput,
): Promise<PurchaseLeaseResult> {
  const contract = makeLeaseContract(input.chain, wallet);
  const overrides = {
    value: BigInt(input.priceWei),
    maxFeePerGas: 200_000_000n,
    maxPriorityFeePerGas: 100_000n,
  };
  const tx = await contract.purchaseLease(BigInt(input.listingId), overrides);
  const receipt = await tx.wait();
  if (!receipt) throw new Error("purchaseLease receipt null");

  const iface = contract.interface;
  for (const lg of receipt.logs ?? []) {
    try {
      const parsed = iface.parseLog({ topics: lg.topics as string[], data: lg.data });
      if (parsed?.name === "LeaseGranted") {
        return {
          leaseId: (parsed.args.leaseId as bigint).toString(),
          listingId: (parsed.args.listingId as bigint).toString(),
          lessee: parsed.args.lessee as string,
          tokenId: (parsed.args.tokenId as bigint).toString(),
          expiresAt: (parsed.args.expiresAt as bigint).toString(),
          accConditionsHash: parsed.args.accConditionsHash as string,
          txHash: receipt.hash,
          blockNumber: receipt.blockNumber,
        };
      }
    } catch {
      // ignore
    }
  }
  throw new Error("LeaseGranted event not found");
}

export interface ListingRecord {
  listingId: string;
  creator: string;
  tokenId: string;
  priceWei: string;
  durationSecs: string;
  accConditionsHash: string;
  active: boolean;
}

export async function readListing(
  chain: DataMarketChainId,
  listingId: string,
): Promise<ListingRecord> {
  const contract = makeLeaseContract(chain);
  const id = BigInt(listingId);
  const [creator, tokenId, priceWei, durationSecs, accHash, active] = await Promise.all([
    contract.listingCreator(id),
    contract.listingTokenId(id),
    contract.listingPriceWei(id),
    contract.listingDurationSecs(id),
    contract.listingAccHash(id),
    contract.listingActive(id),
  ]);
  return {
    listingId,
    creator: creator as string,
    tokenId: (tokenId as bigint).toString(),
    priceWei: (priceWei as bigint).toString(),
    durationSecs: (durationSecs as bigint).toString(),
    accConditionsHash: accHash as string,
    active: active as boolean,
  };
}

export async function hasActiveLease(
  chain: DataMarketChainId,
  listingId: string,
  lessee: string,
): Promise<boolean> {
  if (!ethers.isAddress(lessee)) throw new Error("invalid lessee address");
  const contract = makeLeaseContract(chain);
  return (await contract.hasActiveLease(BigInt(listingId), lessee)) as boolean;
}

export { ZERO_ADDRESS };
