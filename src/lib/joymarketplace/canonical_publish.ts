/**
 * Canonical Joy Marketplace publish — the flow the marketplace's own
 * `scripts/publish-asset.mjs` performs, run from JoyCreate's main process.
 *
 *   wallet-auth session
 *     -> resolve the store's drop clone + reserve its next token id
 *     -> pin cover image
 *     -> encrypt + chunk the content (AES-256-GCM, key wrapped by Lit Chipotle)
 *     -> pin every chunk as raw `iv || ciphertext`, Merkle-root the ciphertexts
 *     -> pin the decryption envelope
 *     -> pin NFT metadata into a tokenId-named directory
 *     -> lazyMint (re-checking the token id first) + setClaimConditions
 *     -> read uri(tokenId) back and confirm it resolves
 *
 * Why this exists alongside `publish_orchestrator.ts`: the orchestrator's
 * existing path pins content UNENCRYPTED, writes a `properties{}` metadata bag
 * the marketplace does not read, and mints to a shared drop the marketplace no
 * longer indexes. Rather than thread four incompatible changes through a
 * function that also handles Celestia anchoring, DataProvenance and two other
 * chains, the canonical path lives here and the orchestrator delegates to it.
 *
 * KNOWN GAP: the IPLD chunk manifest (`ipld_manifest_cid`) is not yet produced.
 * `PublishPage.tsx` treats it as non-fatal and the field is optional in the
 * metadata, so assets published here are complete and openable without it —
 * but they carry no manifest until `@/ipld` grows an equivalent to the
 * marketplace's `createAndUploadChunkManifest`.
 */

import { ethers } from "ethers";
import log from "electron-log";

import { ARBITRUM_SEPOLIA } from "@/config/joymarketplace";
import { getMarketplaceSession } from "./marketplace_session";
import {
  ipfsGatewayUrl,
  uploadBinaryToIPFS,
  uploadJsonToIPFS,
  uploadMetadataDirectory,
} from "./marketplace_ipfs";
import {
  METADATA_ENCRYPTION_VERSION,
  beginChunkedEncryption,
  buildEnvelope,
  computeMerkleRoot,
  encryptChunkAt,
  packChunk,
} from "./lit_encryption";
import {
  mintEdition,
  readNextTokenId,
  resolveStoreDrop,
  verifyTokenUri,
} from "./store_drop_publisher";

const logger = log.scope("canonical_publish");

/** Concurrent chunk encrypt+pin tasks. Round trips dominate; 4 is well clear of
 *  the edge function's rate limit while cutting wall time ~4x on big assets. */
const CHUNK_CONCURRENCY = 4;

export interface CanonicalPublishInput {
  wallet: ethers.Wallet;
  /** Store ENS label, e.g. "acme-models" for acme-models.joymarketplace.io. */
  storeLabel: string;
  name: string;
  description?: string;
  /** Raw content bytes — encrypted before anything leaves the machine. */
  content: Buffer;
  contentFileName: string;
  contentMimeType?: string;
  /** Cover art. Without it the listing renders with no image. */
  coverImage?: { bytes: Buffer; mimeType: string; fileName: string };
  /** Pre-pinned cover CID, if the caller already has one. */
  coverImageCid?: string;
  /** USDC base units (6 decimals). 0 = free. */
  priceUsdc?: bigint;
  royaltyBps?: number;
  licenseType?: string;
  assetCategory?: string;
  /** Extra `{trait_type, value}` pairs appended to `attributes`. */
  extraAttributes?: Array<{ trait_type: string; value: string }>;
  onProgress?: (stage: string) => void;
}

export interface CanonicalPublishResult {
  tokenId: string;
  dropAddress: string;
  storeLabel: string;
  metadataCid: string;
  metadataUri: string;
  envelopeCid: string;
  merkleRoot: string;
  chunkCids: string[];
  imageCid?: string;
  lazyMintTxHash: string;
  setClaimTxHash: string;
  /** Non-fatal post-mint check on uri(tokenId). */
  uriCheck: { ok: boolean; uri?: string; detail?: string };
}

/** Bounded-concurrency map that preserves input order in the output. */
async function runPool<T, R>(
  items: T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await task(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

export async function publishToMarketplace(
  input: CanonicalPublishInput,
): Promise<CanonicalPublishResult> {
  const progress = input.onProgress ?? (() => {});
  const wallet = input.wallet;
  const provider = wallet.provider;
  if (!provider) throw new Error("wallet has no provider");

  const storeLabel = input.storeLabel.trim().toLowerCase();
  if (!storeLabel) throw new Error("storeLabel is required");
  if (!input.content?.length) throw new Error("content is empty");

  // ── 1. authenticated session ─────────────────────────────────────────────
  progress("Authenticating with Joy Marketplace...");
  const session = await getMarketplaceSession(wallet);

  // ── 2. store drop + token id ─────────────────────────────────────────────
  progress("Resolving store drop contract...");
  const dropAddress = await resolveStoreDrop(provider, storeLabel);
  const tokenId = await readNextTokenId(provider, dropAddress);
  logger.info(`publishing to ${storeLabel} drop ${dropAddress} as token #${tokenId}`);

  // ── 3. cover image ───────────────────────────────────────────────────────
  let imageCid = input.coverImageCid;
  if (!imageCid && input.coverImage) {
    progress("Pinning cover image...");
    imageCid = await uploadBinaryToIPFS(
      session,
      input.coverImage.bytes,
      input.coverImage.mimeType,
      input.coverImage.fileName,
    );
  }

  // ── 4. encrypt + chunk ───────────────────────────────────────────────────
  //
  // The token id is fixed BEFORE this point on purpose: it is baked into the
  // access control conditions, so the encryption is bound to the exact token
  // the buyer will hold.
  progress("Encrypting content...");
  const plan = await beginChunkedEncryption(session, {
    size: input.content.length,
    name: input.contentFileName,
    mimeType: input.contentMimeType ?? "application/octet-stream",
    dropAddress,
    tokenId: tokenId.toString(),
    chainId: ARBITRUM_SEPOLIA.chainId,
  });

  progress(`Encrypting and pinning ${plan.chunkCount} chunks...`);
  const indices = Array.from({ length: plan.chunkCount }, (_, i) => i);
  let done = 0;
  const results = await runPool(indices, CHUNK_CONCURRENCY, async (i) => {
    const chunk = await encryptChunkAt(input.content, i, plan);
    const cid = await uploadBinaryToIPFS(
      session,
      packChunk(chunk),
      "application/octet-stream",
      `${input.contentFileName}.chunk.${i}`,
    );
    progress(`Pinned chunk ${++done}/${plan.chunkCount}`);
    return { cid, hash: chunk.hash };
  });

  const chunkCids = results.map((r) => r.cid);
  const chunkHashes = results.map((r) => r.hash);

  // ── 5. Merkle root + envelope ────────────────────────────────────────────
  progress("Computing Merkle root...");
  const merkleRoot = await computeMerkleRoot(chunkHashes);
  const merkleRoot0x = `0x${merkleRoot}`;

  progress("Pinning decryption envelope...");
  const envelope = buildEnvelope(plan, chunkCids, chunkHashes, merkleRoot0x);
  const envelopeCid = await uploadJsonToIPFS(
    session,
    envelope,
    "decryption-envelope.json",
  );

  // ── 6. NFT metadata ──────────────────────────────────────────────────────
  //
  // Flat top-level keys plus `attributes[]` — the shape every marketplace
  // filter, card and store page reads. A nested `properties{}` bag indexes but
  // renders with no store, no category and no traits.
  progress("Pinning NFT metadata...");
  const royaltyBps = Math.min(Math.max(input.royaltyBps ?? 250, 0), 5000);
  const storeDomain = `${storeLabel}.joymarketplace.io`;
  const priceUsdc = input.priceUsdc ?? 0n;

  const metadata = {
    name: input.name,
    description: input.description ?? `Content license NFT for ${input.contentFileName}`,
    image: imageCid ? `ipfs://${imageCid}` : undefined,
    encrypted_content_cid: envelopeCid,
    encryption_version: METADATA_ENCRYPTION_VERSION,
    decryption_envelope_cid: envelopeCid,
    merkle_root: merkleRoot0x,
    fileName: input.contentFileName,
    category: input.assetCategory,
    seller_fee_basis_points: royaltyBps,
    fee_recipient: wallet.address,
    store: storeLabel,
    storeDomain,
    attributes: [
      { trait_type: "Store", value: storeLabel },
      { trait_type: "Store Domain", value: storeDomain },
      { trait_type: "License Type", value: input.licenseType ?? "Commercial" },
      {
        trait_type: "Content Type",
        value: input.contentMimeType ?? "application/octet-stream",
      },
      { trait_type: "File Name", value: input.contentFileName },
      {
        trait_type: "File Size",
        value: `${(input.content.length / 1024).toFixed(2)} KB`,
      },
      { trait_type: "Encryption", value: "AES-256-GCM + Lit Protocol (chunked)" },
      { trait_type: "Chunk Count", value: String(plan.chunkCount) },
      { trait_type: "Merkle Root", value: merkleRoot0x },
      { trait_type: "Published From", value: "JoyCreate" },
      ...(input.assetCategory
        ? [{ trait_type: "Category", value: input.assetCategory }]
        : []),
      ...(input.extraAttributes ?? []),
    ],
  };

  const { cid: metadataCid, uri: metadataUri } = await uploadMetadataDirectory(
    session,
    metadata,
    tokenId,
  );

  // ── 7. mint + list ───────────────────────────────────────────────────────
  progress("Minting on-chain...");
  const mint = await mintEdition(wallet, {
    dropAddress,
    metadataUri,
    expectedTokenId: tokenId,
    priceUsdc,
  });

  // ── 8. post-mint URI check ───────────────────────────────────────────────
  progress("Verifying token metadata resolves...");
  const uriCheck = await verifyTokenUri(
    provider,
    dropAddress,
    mint.tokenId,
    ipfsGatewayUrl,
  );
  if (!uriCheck.ok) logger.warn(uriCheck.detail);

  logger.info(`published token #${mint.tokenId} to ${storeDomain}`);

  return {
    tokenId: mint.tokenId,
    dropAddress,
    storeLabel,
    metadataCid,
    metadataUri,
    envelopeCid,
    merkleRoot: merkleRoot0x,
    chunkCids,
    imageCid,
    lazyMintTxHash: mint.lazyMintTxHash,
    setClaimTxHash: mint.setClaimTxHash,
    uriCheck,
  };
}
