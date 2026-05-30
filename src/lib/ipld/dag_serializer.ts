/**
 * IPLD DAG serializer — turns a created asset + its provenance manifest into a
 * content-addressed IPLD Merkle DAG ("shard").
 *
 * Pipeline position (JOY Web 4.0):
 *   Human Input ── DAG-CBOR Serialization ──► IPLD Merkle DAG Shard ──► ERC-1155
 *
 * The shard is a small dag-cbor root node that commits to:
 *   - the SHA-256 of the raw asset bytes (content integrity),
 *   - the asset's IPFS CID (where the bytes actually live), and
 *   - a linked dag-cbor block holding the canonical ProvenanceManifest.
 *
 * The raw asset bytes (which can be large, e.g. video) are NOT inlined into the
 * DAG — they stay on IPFS via the existing pinning path. The shard is a compact
 * cryptographic envelope suitable for Celestia DA anchoring and for deriving the
 * `bytes32` merkle root consumed by the on-chain DataProvenance contract.
 */

import { createHash } from "node:crypto";

import * as dagCbor from "@ipld/dag-cbor";
import * as Block from "multiformats/block";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";

import type { ProvenanceManifest } from "@/types/provenance";

/** Current shard schema version. Bump on breaking changes to the root node. */
export const ASSET_SHARD_VERSION = 1 as const;

export interface BuildShardInput {
  /** Raw asset bytes (image/video/etc). Used only to compute the content hash. */
  content: Buffer;
  /** MIME type of the asset bytes. */
  contentMimeType?: string;
  /**
   * IPFS CID (raw string, with or without the `ipfs://` prefix) where the
   * asset bytes are pinned. Optional — when absent the shard still commits to
   * the content hash.
   */
  contentCid?: string;
  /** Human-readable asset name. */
  name: string;
  /** Asset category (mirrors PublishInput.assetType). */
  assetType: string;
  /** Canonical provenance manifest produced at generation time. */
  provenance: ProvenanceManifest;
}

/** A single IPLD block (CID + encoded bytes). */
export interface ShardBlock {
  cid: CID;
  bytes: Uint8Array;
}

export interface AssetShard {
  /** Root CID of the shard (dag-cbor, sha2-256). */
  rootCid: CID;
  /** Root CID as a string (e.g. "bafyrei…"). */
  rootCidStr: string;
  /**
   * The shard's merkle root as a 0x-prefixed 32-byte hex string — the sha2-256
   * digest embedded in the root CID's multihash. This is the value fed to
   * `DataProvenance.mintProvenance(merkleRoot, …)`.
   */
  merkleRootHex: string;
  /** SHA-256 of the raw asset bytes, 0x-prefixed hex. */
  contentHashHex: string;
  /** All blocks in the DAG (root first), for transport/anchoring. */
  blocks: ShardBlock[];
  /** CAR v1 encoding of the DAG (roots=[rootCid]). */
  carBytes: Uint8Array;
}

/** The decoded shape of the shard's dag-cbor root node. */
export interface ShardRootNode {
  v: number;
  kind: "joy-asset-shard";
  name: string;
  assetType: string;
  mimeType: string | null;
  /** SHA-256 of the raw asset bytes, as raw bytes. */
  contentHash: Uint8Array;
  /** Asset byte length. */
  size: number;
  /** IPFS CID string where bytes are pinned, or null. */
  contentCid: string | null;
  /** Link to the provenance block. */
  provenance: CID;
  /** ISO-8601 UTC timestamp. */
  createdAt: string;
}

function sha256Hex(data: Buffer): string {
  return `0x${createHash("sha256").update(data).digest("hex")}`;
}

function toHex(bytes: Uint8Array): string {
  return `0x${Buffer.from(bytes).toString("hex")}`;
}

/**
 * Build the IPLD Merkle DAG shard for an asset.
 *
 * Pure/deterministic given identical inputs (modulo the provenance timestamp,
 * which is sealed upstream in the manifest).
 */
export async function buildAssetShard(input: BuildShardInput): Promise<AssetShard> {
  const contentHash = createHash("sha256").update(input.content).digest();

  // Provenance leaf block (dag-cbor).
  const provenanceBlock = await Block.encode({
    value: input.provenance as unknown as Record<string, unknown>,
    codec: dagCbor,
    hasher: sha256,
  });

  // Root node — commits to content + links the provenance block.
  const rootNode: ShardRootNode = {
    v: ASSET_SHARD_VERSION,
    kind: "joy-asset-shard",
    name: input.name,
    assetType: input.assetType,
    mimeType: input.contentMimeType ?? null,
    contentHash: new Uint8Array(contentHash),
    size: input.content.length,
    contentCid: normalizeCidString(input.contentCid),
    provenance: provenanceBlock.cid,
    createdAt: new Date().toISOString(),
  };

  const rootBlock = await Block.encode({
    value: rootNode as unknown as Record<string, unknown>,
    codec: dagCbor,
    hasher: sha256,
  });

  const blocks: ShardBlock[] = [
    { cid: rootBlock.cid, bytes: rootBlock.bytes },
    { cid: provenanceBlock.cid, bytes: provenanceBlock.bytes },
  ];

  const carBytes = encodeCarV1(rootBlock.cid, blocks);

  return {
    rootCid: rootBlock.cid,
    rootCidStr: rootBlock.cid.toString(),
    // The multihash digest of a sha2-256 dag-cbor block is exactly 32 bytes.
    merkleRootHex: toHex(rootBlock.cid.multihash.digest),
    contentHashHex: sha256Hex(input.content),
    blocks,
    carBytes,
  };
}

function normalizeCidString(cid?: string): string | null {
  if (!cid) return null;
  return cid.startsWith("ipfs://") ? cid.slice("ipfs://".length) : cid;
}

// ---------------------------------------------------------------------------
// Minimal CAR v1 encoder
// ---------------------------------------------------------------------------
// CARv1 layout:
//   varint(len(header)) ++ header(dag-cbor {version:1, roots:[CID]})
//   for each block: varint(len(cidBytes)+len(blockBytes)) ++ cidBytes ++ blockBytes
// Reference: https://ipld.io/specs/transport/car/carv1/

function encodeVarint(value: number): Uint8Array {
  if (value < 0 || !Number.isInteger(value)) {
    throw new Error(`encodeVarint: invalid value ${value}`);
  }
  const out: number[] = [];
  let v = value;
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v);
  return Uint8Array.from(out);
}

function encodeCarV1(root: CID, blocks: ShardBlock[]): Uint8Array {
  const header = dagCbor.encode({ version: 1, roots: [root] });
  const parts: Uint8Array[] = [encodeVarint(header.length), header];

  for (const block of blocks) {
    const cidBytes = block.cid.bytes;
    const frameLen = cidBytes.length + block.bytes.length;
    parts.push(encodeVarint(frameLen), cidBytes, block.bytes);
  }

  const total = parts.reduce((n, p) => n + p.length, 0);
  const buf = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    buf.set(p, offset);
    offset += p.length;
  }
  return buf;
}
