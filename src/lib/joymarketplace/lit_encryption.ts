/**
 * Node port of the marketplace's `chunked-aes-lit-v2` encryption.
 *
 * This is a deliberate, careful mirror of `mfe-agents-quest/src/lib/lit.ts`
 * (browser) so that assets published from JoyCreate are decryptable by the
 * marketplace's existing reader. Every constant, hash input and field name
 * below is load-bearing:
 *
 *   - `chunkHashes[i]` is SHA-256 of the CIPHERTEXT ONLY, never of
 *     `iv || ciphertext`. That is what keeps `computeMerkleRoot` identical
 *     across v1 and v2 and what the on-chain `merkle_root` commits to.
 *   - Each chunk is PINNED as raw `[12-byte IV][ciphertext]` bytes
 *     (`raw-iv-prefixed`). The v1 JSON-of-decimal-arrays format inflated
 *     storage ~3.57x and the reader distinguishes the two by `chunkFormat`.
 *   - The Merkle tree hashes the CONCATENATED HEX STRINGS of the two children
 *     as UTF-8 text, not their bytes. Odd nodes are duplicated. A divergence
 *     here rejects every asset this produces.
 *   - The access control conditions embed the drop address and tokenId. Under
 *     Chipotle, Lit does not enforce them — `decrypt-asset.js` re-derives the
 *     `balanceOf` check from `contractAddress`/`tokenId`/`chain` read back out
 *     of this blob. So the shape is what makes an asset openable at all, and
 *     the tokenId must be final before `beginChunkedEncryption` is called.
 *
 * The AES key is wrapped by the `lit-chipotle` edge function, which holds the
 * Chipotle usage key and PKP id server-side. That call requires an
 * authenticated Supabase session — see `marketplace_session.ts`.
 */

import log from "electron-log";

import { JOYMARKETPLACE_API } from "@/config/joymarketplace";
import type { MarketplaceSession } from "./marketplace_session";

const logger = log.scope("lit_encryption");

const SUPABASE_URL = JOYMARKETPLACE_API.supabaseUrl;
const SUPABASE_ANON_KEY = JOYMARKETPLACE_API.supabaseAnonKey;

// ── Constants — must match mfe-agents-quest/src/lib/lit.ts ──────────────────

const AES_ALGORITHM = "AES-GCM";
const AES_KEY_LENGTH = 256;
/** AES-GCM IV length in bytes. Prefixes every pinned chunk on v2. */
export const IV_LENGTH = 12;

const CHUNK_SIZE = 1024 * 1024; // 1 MB
const MAX_CHUNK_SIZE = 8 * 1024 * 1024; // 8 MB

/** Envelope format this build writes. */
export const ENVELOPE_VERSION = "chunked-aes-lit-v2";
/** Chunk layout marker for v2 — raw `iv || ciphertext` bytes. */
export const CHUNK_FORMAT_RAW_IV_PREFIXED = "raw-iv-prefixed";

/**
 * Value written to the NFT metadata's `encryption_version` field.
 *
 * Intentionally NOT `ENVELOPE_VERSION`. The marketplace's `PublishPage.tsx`
 * writes `chunked-aes-lit-v1` into NFT metadata while writing
 * `chunked-aes-lit-v2` into the envelope itself, and readers key off the
 * envelope. Matching that split exactly keeps JoyCreate assets
 * indistinguishable from marketplace-published ones; "fixing" the
 * inconsistency here would make them differ.
 */
export const METADATA_ENCRYPTION_VERSION = "chunked-aes-lit-v1";

const LIT_CHAIN_NAMES: Record<number, string> = {
  421614: "arbitrumSepolia",
  42161: "arbitrum",
};
const DEFAULT_LIT_CHAIN = "arbitrumSepolia";

export function getLitChainName(chainId?: number): string {
  if (chainId && LIT_CHAIN_NAMES[chainId]) return LIT_CHAIN_NAMES[chainId];
  return DEFAULT_LIT_CHAIN;
}

/** Plaintext bytes per chunk, by total size. Deterministic in `fileSize`. */
export function pickChunkSize(fileSize: number): number {
  const MB = 1024 * 1024;
  if (fileSize <= 64 * MB) return CHUNK_SIZE; // <= 64 chunks
  if (fileSize <= 512 * MB) return 4 * MB; // <= 128 chunks
  return MAX_CHUNK_SIZE; // 2 GB -> 256 chunks
}

// ── Hashing ─────────────────────────────────────────────────────────────────

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    data as unknown as ArrayBuffer,
  );
  return toHex(new Uint8Array(digest));
}

/**
 * SHA-256 Merkle root over ordered hex chunk hashes.
 *
 * Must stay byte-identical to `computeMerkleRoot` in
 * `mfe-agents-quest/src/lib/lit/envelopeMeta.ts` — the two hash the
 * CONCATENATED HEX STRINGS as UTF-8, not the decoded bytes.
 */
export async function computeMerkleRoot(hashes: string[]): Promise<string> {
  if (hashes.length === 0) return "";
  if (hashes.length === 1) return hashes[0];
  let level = hashes;
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = i + 1 < level.length ? level[i + 1] : left;
      const buf = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(left + right) as unknown as ArrayBuffer,
      );
      next.push(toHex(new Uint8Array(buf)));
    }
    level = next;
  }
  return level[0];
}

// ── Lit key wrapping ────────────────────────────────────────────────────────

async function invokeLitChipotle(
  session: MarketplaceSession,
  body: Record<string, unknown>,
): Promise<Record<string, any>> {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/lit-chipotle`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      apikey: SUPABASE_ANON_KEY,
      authorization: `Bearer ${session.accessToken}`,
    },
    body: JSON.stringify(body),
  });

  let json: any = {};
  try {
    json = await res.json();
  } catch {
    /* status-based error below */
  }

  if (!res.ok || json?.success === false) {
    throw new Error(
      `lit-chipotle ${String(body.op)} failed (${res.status}): ${
        json?.error ?? "no detail"
      }`,
    );
  }
  return json;
}

// ── Chunked encryption ──────────────────────────────────────────────────────

export interface AccessControlCondition {
  conditionType: "evmBasic";
  contractAddress: string;
  standardContractType: "ERC1155";
  chain: string;
  method: "balanceOf";
  parameters: [":userAddress", string];
  returnValueTest: { comparator: ">"; value: "0" };
}

export interface ChunkedEncryptionPlan {
  aesKey: CryptoKey;
  litWrappedKey: { ciphertext: string };
  accs: AccessControlCondition[];
  chunkSize: number;
  chunkCount: number;
  originalSize: number;
  originalName: string;
  originalType: string;
}

export interface EncryptedChunk {
  index: number;
  iv: Uint8Array;
  ciphertext: Uint8Array;
  /** SHA-256 hex of the ciphertext only. */
  hash: string;
}

/**
 * Generate an AES key, wrap it with Lit, and plan the chunking.
 *
 * `dropAddress` and `tokenId` are baked into the access control conditions, so
 * they must be the FINAL values — re-minting at a different tokenId makes every
 * chunk produced under this plan permanently unopenable.
 */
export async function beginChunkedEncryption(
  session: MarketplaceSession,
  input: {
    size: number;
    name: string;
    mimeType: string;
    dropAddress: string;
    tokenId: string;
    chainId?: number;
  },
): Promise<ChunkedEncryptionPlan> {
  const accs: AccessControlCondition[] = [
    {
      conditionType: "evmBasic",
      contractAddress: input.dropAddress,
      standardContractType: "ERC1155",
      chain: getLitChainName(input.chainId),
      method: "balanceOf",
      parameters: [":userAddress", input.tokenId],
      returnValueTest: { comparator: ">", value: "0" },
    },
  ];

  const aesKey = await crypto.subtle.generateKey(
    { name: AES_ALGORITHM, length: AES_KEY_LENGTH },
    true, // extractable so Lit can wrap it
    ["encrypt", "decrypt"],
  );

  const rawKey = new Uint8Array(
    (await crypto.subtle.exportKey("raw", aesKey)) as ArrayBuffer,
  );
  const { ciphertext } = await invokeLitChipotle(session, {
    op: "encrypt",
    message: toHex(rawKey),
  });
  if (typeof ciphertext !== "string" || ciphertext.length === 0) {
    throw new Error("lit-chipotle encrypt returned no ciphertext");
  }

  const chunkSize = pickChunkSize(input.size);
  logger.info(
    `encryption planned: ${input.size} bytes in ${Math.max(
      1,
      Math.ceil(input.size / chunkSize),
    )} chunks of ${chunkSize}`,
  );

  return {
    aesKey,
    litWrappedKey: { ciphertext },
    accs,
    chunkSize,
    chunkCount: Math.max(1, Math.ceil(input.size / chunkSize)),
    originalSize: input.size,
    originalName: input.name,
    originalType: input.mimeType || "application/octet-stream",
  };
}

/** Encrypt exactly one chunk of `content`. */
export async function encryptChunkAt(
  content: Buffer,
  index: number,
  plan: Pick<ChunkedEncryptionPlan, "aesKey" | "chunkSize">,
): Promise<EncryptedChunk> {
  const start = index * plan.chunkSize;
  const end = Math.min(start + plan.chunkSize, content.length);
  const slice = content.subarray(start, end);

  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const ciphertext = new Uint8Array(
    (await crypto.subtle.encrypt(
      { name: AES_ALGORITHM, iv: iv as unknown as ArrayBuffer },
      plan.aesKey,
      slice as unknown as ArrayBuffer,
    )) as ArrayBuffer,
  );

  return { index, iv, ciphertext, hash: await sha256Hex(ciphertext) };
}

/** Bytes actually pinned for a v2 chunk: `iv || ciphertext`. */
export function packChunk(chunk: EncryptedChunk): Buffer {
  return Buffer.concat([Buffer.from(chunk.iv), Buffer.from(chunk.ciphertext)]);
}

export interface DecryptionEnvelope {
  version: string;
  chunkFormat: string;
  ivLength: number;
  chunkSize: number;
  chunkCount: number;
  litWrappedKey: { ciphertext: string };
  accessControlConditions: AccessControlCondition[];
  chunkCids: string[];
  chunkHashes: string[];
  /** 0x-prefixed. */
  merkleRoot: string;
  originalSize: number;
  originalName: string;
  originalType: string;
}

/** Assemble the envelope exactly as `PublishPage.tsx` writes it. */
export function buildEnvelope(
  plan: ChunkedEncryptionPlan,
  chunkCids: string[],
  chunkHashes: string[],
  merkleRoot0x: string,
): DecryptionEnvelope {
  return {
    version: ENVELOPE_VERSION,
    chunkFormat: CHUNK_FORMAT_RAW_IV_PREFIXED,
    ivLength: IV_LENGTH,
    chunkSize: plan.chunkSize,
    chunkCount: chunkCids.length,
    litWrappedKey: plan.litWrappedKey,
    accessControlConditions: plan.accs,
    chunkCids,
    chunkHashes,
    merkleRoot: merkleRoot0x,
    originalSize: plan.originalSize,
    originalName: plan.originalName,
    originalType: plan.originalType,
  };
}
