/**
 * Model P2P Distribution — Phase 5 of the JoyCreate completion plan.
 *
 * Adds verifiable, chunked transfer of model weights on top of the existing
 * IPFS/Helia content-addressed storage:
 *
 *   - `ModelChunkManifest` — describes every chunk of a model (sha256 + CID),
 *     plus optional ed25519/ECDSA signature from the publisher.
 *   - `createModelManifest()` splits a file into ~CHUNK_SIZE blocks, hashes
 *     each block, pushes them into Helia, and assembles a manifest.
 *   - `verifyManifest()` re-checks the merkle root and (when a signature is
 *     present) the publisher signature against an expected wallet address.
 *   - `downloadFromManifest()` re-fetches each chunk via Helia, verifies the
 *     per-chunk sha256, and writes the reassembled file to disk while
 *     emitting progress callbacks.
 *   - `parseSemver()` / `compareSemver()` — light helpers used by the registry
 *     to resolve version ranges without pulling in a heavy semver dependency.
 *
 * This module is main-process only (Node `crypto` + `fs`).
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import log from "electron-log";
import { verifyMessage } from "ethers";

import { heliaVerificationService } from "@/lib/helia_verification_service";

const logger = log.scope("model_p2p_distribution");

/** Default chunk size — 4 MiB balances IPFS block overhead vs. resume granularity. */
export const DEFAULT_CHUNK_SIZE = 4 * 1024 * 1024;

// =============================================================================
// TYPES
// =============================================================================

export interface ModelChunkDescriptor {
  /** 0-based index of this chunk in the original file. */
  index: number;
  /** Byte offset of this chunk in the original file. */
  offset: number;
  /** Size of this chunk in bytes. */
  size: number;
  /** Lowercase hex sha256 of the chunk's raw bytes. */
  sha256: string;
  /** IPFS CID of the chunk's bytes (UnixFS via Helia). */
  cid: string;
}

export interface ModelManifestSignature {
  /** Ethereum-style wallet address of the publisher. */
  address: string;
  /** EIP-191 signature of the manifest's `signingDigest`. */
  value: string;
  /** Algorithm tag — currently always `"ethereum-personal-sign"`. */
  algorithm: "ethereum-personal-sign";
}

export interface ModelChunkManifest {
  /** Manifest format version — bump when fields change. */
  manifestVersion: 1;
  /** Logical model identifier (e.g. registry entry id, or `name@version`). */
  modelId: string;
  /** Semver of the model release this manifest describes. */
  version: string;
  /** Lowercase hex sha256 of the full reassembled file. */
  contentHash: string;
  /** Hex sha256 merkle root of all chunk hashes (level-by-level pairing). */
  merkleRoot: string;
  /** Total size of the reassembled file in bytes. */
  totalBytes: number;
  /** Chunk size used during creation — informational. */
  chunkSize: number;
  /** All chunks in order. */
  chunks: ModelChunkDescriptor[];
  /** Unix epoch ms when the manifest was created. */
  createdAt: number;
  /** Optional publisher signature. */
  signature?: ModelManifestSignature;
}

export interface DownloadProgress {
  /** Total chunks in the manifest. */
  totalChunks: number;
  /** Chunks successfully fetched + verified. */
  completedChunks: number;
  /** Bytes written to the output file so far. */
  bytesWritten: number;
  /** Total bytes that will eventually be written. */
  totalBytes: number;
  /** 0-100 percent. */
  percent: number;
  /** Chunk index currently being processed, if any. */
  currentChunkIndex?: number;
}

export interface DownloadOptions {
  /** Output path for the reassembled file. */
  outputPath: string;
  /** Optional progress callback. */
  onProgress?: (p: DownloadProgress) => void;
  /** Maximum retry attempts per chunk before failing the download. */
  maxRetriesPerChunk?: number;
  /** Optional expected publisher address — if set, signature must match. */
  requirePublisherAddress?: string;
}

export interface DownloadResult {
  outputPath: string;
  bytesWritten: number;
  chunksFetched: number;
  contentHash: string;
  signatureValid: boolean | null;
}

// =============================================================================
// HASHING
// =============================================================================

function sha256Hex(buf: Buffer | Uint8Array): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

async function sha256File(filePath: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve());
    stream.on("error", reject);
  });
  return hash.digest("hex");
}

/** Pairwise sha256 merkle root over a list of lowercase hex hashes. */
export function computeMerkleRoot(leaves: string[]): string {
  if (leaves.length === 0) {
    return sha256Hex(Buffer.alloc(0));
  }
  let level = leaves.map((h) => Buffer.from(h, "hex"));
  while (level.length > 1) {
    const next: Buffer[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const a = level[i];
      const b = i + 1 < level.length ? level[i + 1] : a;
      next.push(crypto.createHash("sha256").update(Buffer.concat([a, b])).digest());
    }
    level = next;
  }
  return level[0].toString("hex");
}

// =============================================================================
// SIGNING
// =============================================================================

/**
 * Build the canonical signing digest for a manifest. Mutating any field
 * covered here invalidates the signature.
 */
export function manifestSigningDigest(
  m: Omit<ModelChunkManifest, "signature">,
): string {
  const payload = {
    v: m.manifestVersion,
    modelId: m.modelId,
    version: m.version,
    contentHash: m.contentHash,
    merkleRoot: m.merkleRoot,
    totalBytes: m.totalBytes,
    chunkSize: m.chunkSize,
    chunkCount: m.chunks.length,
    createdAt: m.createdAt,
  };
  return sha256Hex(Buffer.from(JSON.stringify(payload)));
}

/**
 * Attach an EIP-191 signature to a manifest. The caller is responsible for
 * producing the signature (e.g. via `joy_wallet.signMessage` in the renderer,
 * or any wallet-backed signer) and supplying the address it was signed with.
 */
export function attachManifestSignature(
  manifest: Omit<ModelChunkManifest, "signature">,
  address: string,
  signature: string,
): ModelChunkManifest {
  return {
    ...manifest,
    signature: {
      address,
      value: signature,
      algorithm: "ethereum-personal-sign",
    },
  };
}

/**
 * Verify a manifest's structural integrity and (when present) its publisher
 * signature. Throws on the first hard failure so callers don't accidentally
 * trust a bad manifest.
 */
export function verifyManifest(
  manifest: ModelChunkManifest,
  opts: { requirePublisherAddress?: string } = {},
): { signatureValid: boolean | null } {
  if (manifest.manifestVersion !== 1) {
    throw new Error(`Unsupported manifest version: ${manifest.manifestVersion}`);
  }
  if (manifest.chunks.length === 0) {
    throw new Error("Manifest has no chunks");
  }

  // Re-check merkle root against the listed chunk hashes.
  const computedRoot = computeMerkleRoot(manifest.chunks.map((c) => c.sha256));
  if (computedRoot !== manifest.merkleRoot) {
    throw new Error(
      `Merkle root mismatch: manifest=${manifest.merkleRoot} computed=${computedRoot}`,
    );
  }

  // Re-check total bytes.
  const totalFromChunks = manifest.chunks.reduce((sum, c) => sum + c.size, 0);
  if (totalFromChunks !== manifest.totalBytes) {
    throw new Error(
      `Total bytes mismatch: manifest=${manifest.totalBytes} sum=${totalFromChunks}`,
    );
  }

  // Verify signature when present.
  let signatureValid: boolean | null = null;
  if (manifest.signature) {
    const digest = manifestSigningDigest({
      manifestVersion: manifest.manifestVersion,
      modelId: manifest.modelId,
      version: manifest.version,
      contentHash: manifest.contentHash,
      merkleRoot: manifest.merkleRoot,
      totalBytes: manifest.totalBytes,
      chunkSize: manifest.chunkSize,
      chunks: manifest.chunks,
      createdAt: manifest.createdAt,
    });
    try {
      const recovered = verifyMessage(digest, manifest.signature.value);
      signatureValid =
        recovered.toLowerCase() === manifest.signature.address.toLowerCase();
    } catch (err) {
      logger.warn("Signature recovery failed:", err);
      signatureValid = false;
    }

    if (
      opts.requirePublisherAddress &&
      opts.requirePublisherAddress.toLowerCase() !==
        manifest.signature.address.toLowerCase()
    ) {
      throw new Error(
        `Publisher address mismatch: expected=${opts.requirePublisherAddress} got=${manifest.signature.address}`,
      );
    }
    if (!signatureValid) {
      throw new Error("Manifest signature is invalid");
    }
  } else if (opts.requirePublisherAddress) {
    throw new Error("Manifest has no signature but publisher address is required");
  }

  return { signatureValid };
}

// =============================================================================
// MANIFEST CREATION
// =============================================================================

export interface CreateManifestParams {
  /** Path to the model file on disk. */
  filePath: string;
  /** Logical model identifier (registry id or `name@version`). */
  modelId: string;
  /** Semver of the model release. */
  version: string;
  /** Chunk size in bytes. Defaults to 4 MiB. */
  chunkSize?: number;
  /** Optional progress callback (per chunk pushed to Helia). */
  onProgress?: (info: {
    chunkIndex: number;
    totalChunks: number;
    bytesProcessed: number;
    totalBytes: number;
  }) => void;
}

/**
 * Read a file from disk, split into chunks, hash + push each chunk into
 * Helia, and assemble an unsigned `ModelChunkManifest`. Use
 * `attachManifestSignature` to add a publisher signature.
 */
export async function createModelManifest(
  params: CreateManifestParams,
): Promise<ModelChunkManifest> {
  const chunkSize = params.chunkSize ?? DEFAULT_CHUNK_SIZE;
  if (chunkSize <= 0) throw new Error("chunkSize must be positive");

  const stat = await fs.stat(params.filePath);
  if (!stat.isFile()) {
    throw new Error(`Not a file: ${params.filePath}`);
  }
  const totalBytes = stat.size;
  const totalChunks = Math.max(1, Math.ceil(totalBytes / chunkSize));

  const contentHash = await sha256File(params.filePath);

  const chunks: ModelChunkDescriptor[] = [];
  const fileHandle = await fs.open(params.filePath, "r");
  try {
    for (let index = 0; index < totalChunks; index++) {
      const offset = index * chunkSize;
      const size = Math.min(chunkSize, totalBytes - offset);
      const buf = Buffer.alloc(size);
      await fileHandle.read(buf, 0, size, offset);

      const sha = sha256Hex(buf);
      const tmpPath = path.join(
        path.dirname(params.filePath),
        `.${path.basename(params.filePath)}.chunk-${index}.tmp`,
      );
      await fs.writeFile(tmpPath, buf);
      let cid: string;
      try {
        const stored = await heliaVerificationService.storeModelChunkFile(tmpPath);
        cid = stored.cid;
      } finally {
        await fs.unlink(tmpPath).catch(() => undefined);
      }

      chunks.push({ index, offset, size, sha256: sha, cid });

      params.onProgress?.({
        chunkIndex: index,
        totalChunks,
        bytesProcessed: offset + size,
        totalBytes,
      });
    }
  } finally {
    await fileHandle.close();
  }

  const merkleRoot = computeMerkleRoot(chunks.map((c) => c.sha256));
  const manifest: ModelChunkManifest = {
    manifestVersion: 1,
    modelId: params.modelId,
    version: params.version,
    contentHash,
    merkleRoot,
    totalBytes,
    chunkSize,
    chunks,
    createdAt: Date.now(),
  };

  // Self-check before returning.
  verifyManifest(manifest);
  return manifest;
}

// =============================================================================
// DOWNLOAD
// =============================================================================

/**
 * Fetch every chunk listed in `manifest` from Helia, verify each chunk's
 * sha256, and reassemble the original file at `opts.outputPath`. Retries
 * each chunk up to `maxRetriesPerChunk` times before giving up.
 */
export async function downloadFromManifest(
  manifest: ModelChunkManifest,
  opts: DownloadOptions,
): Promise<DownloadResult> {
  const { signatureValid } = verifyManifest(manifest, {
    requirePublisherAddress: opts.requirePublisherAddress,
  });

  const maxRetries = Math.max(0, opts.maxRetriesPerChunk ?? 2);
  await fs.mkdir(path.dirname(opts.outputPath), { recursive: true });

  // Write into a temp file then rename, so failure doesn't leave a corrupt
  // file at the target path.
  const tmpOutput = `${opts.outputPath}.partial`;
  const handle = await fs.open(tmpOutput, "w");
  let bytesWritten = 0;
  let completedChunks = 0;

  try {
    for (const chunk of manifest.chunks) {
      let lastErr: unknown;
      let chunkBytes: Buffer | null = null;

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const tmpChunkPath = `${tmpOutput}.chunk-${chunk.index}`;
        try {
          await heliaVerificationService.exportModelChunkToFile(
            chunk.cid,
            tmpChunkPath,
          );
          const data = await fs.readFile(tmpChunkPath);
          if (data.length !== chunk.size) {
            throw new Error(
              `Chunk ${chunk.index} size mismatch: expected=${chunk.size} got=${data.length}`,
            );
          }
          const actualHash = sha256Hex(data);
          if (actualHash !== chunk.sha256) {
            throw new Error(
              `Chunk ${chunk.index} sha256 mismatch: expected=${chunk.sha256} got=${actualHash}`,
            );
          }
          chunkBytes = data;
          break;
        } catch (err) {
          lastErr = err;
          logger.warn(
            `Chunk ${chunk.index} attempt ${attempt + 1}/${maxRetries + 1} failed:`,
            err,
          );
        } finally {
          await fs.unlink(tmpChunkPath).catch(() => undefined);
        }
      }

      if (!chunkBytes) {
        throw new Error(
          `Failed to fetch chunk ${chunk.index} after ${maxRetries + 1} attempts: ${
            lastErr instanceof Error ? lastErr.message : String(lastErr)
          }`,
        );
      }

      await handle.write(chunkBytes, 0, chunkBytes.length, chunk.offset);
      bytesWritten += chunkBytes.length;
      completedChunks++;

      opts.onProgress?.({
        totalChunks: manifest.chunks.length,
        completedChunks,
        bytesWritten,
        totalBytes: manifest.totalBytes,
        percent: Math.round(
          (bytesWritten / Math.max(1, manifest.totalBytes)) * 100,
        ),
        currentChunkIndex: chunk.index,
      });
    }
  } finally {
    await handle.close();
  }

  // Final whole-file hash check.
  const finalHash = await sha256File(tmpOutput);
  if (finalHash !== manifest.contentHash) {
    await fs.unlink(tmpOutput).catch(() => undefined);
    throw new Error(
      `Reassembled file hash mismatch: expected=${manifest.contentHash} got=${finalHash}`,
    );
  }

  await fs.rename(tmpOutput, opts.outputPath);

  return {
    outputPath: opts.outputPath,
    bytesWritten,
    chunksFetched: completedChunks,
    contentHash: finalHash,
    signatureValid,
  };
}

// =============================================================================
// SEMVER (lightweight)
// =============================================================================

export interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
  prerelease: string | null;
}

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

export function parseSemver(input: string): ParsedSemver {
  const m = SEMVER_RE.exec(input.trim());
  if (!m) throw new Error(`Invalid semver: ${input}`);
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ?? null,
  };
}

/** Returns -1 if a<b, 0 if equal, 1 if a>b. */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (pa.major !== pb.major) return pa.major < pb.major ? -1 : 1;
  if (pa.minor !== pb.minor) return pa.minor < pb.minor ? -1 : 1;
  if (pa.patch !== pb.patch) return pa.patch < pb.patch ? -1 : 1;
  if (pa.prerelease === pb.prerelease) return 0;
  // A version with a prerelease is lower than one without.
  if (pa.prerelease === null) return 1;
  if (pb.prerelease === null) return -1;
  return pa.prerelease < pb.prerelease ? -1 : 1;
}
