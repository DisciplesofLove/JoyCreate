/**
 * Conformance tests for the `chunked-aes-lit-v2` port in
 * `src/lib/joymarketplace/lit_encryption.ts`.
 *
 * This module is a re-implementation, in Node, of encryption whose output is
 * consumed by a DIFFERENT codebase (the marketplace's browser reader). A silent
 * divergence here produces assets that mint fine, list fine, verify fine — and
 * can never be decrypted by the buyer who paid for them. On-chain metadata is
 * immutable, so there is no repair.
 *
 * The Merkle vectors below were produced by running the marketplace's own
 * `src/lib/lit/envelopeMeta.ts::computeMerkleRoot` (mfe-agents-quest) over the
 * same inputs. They are the contract; if this file starts failing, the port
 * has drifted, not the expectations.
 */

import { describe, expect, it } from "vitest";

import {
  CHUNK_FORMAT_RAW_IV_PREFIXED,
  ENVELOPE_VERSION,
  IV_LENGTH,
  METADATA_ENCRYPTION_VERSION,
  buildEnvelope,
  computeMerkleRoot,
  encryptChunkAt,
  getLitChainName,
  packChunk,
  pickChunkSize,
  type ChunkedEncryptionPlan,
} from "@/lib/joymarketplace/lit_encryption";

/** A deterministic 32-byte hex hash whose every byte is `n`. */
const h = (n: number) => n.toString(16).padStart(2, "0").repeat(32);

const REFERENCE_ROOTS: Record<number, string> = {
  1: "0101010101010101010101010101010101010101010101010101010101010101",
  2: "7619ddd5684b0b01ec5fdc457a89913cef8aa0b967f8dac2a030d77c70dfa9c7",
  3: "6c973430dd1841197cd6f27594fa4583b5dca930eff6798003fa669aafcdd620",
  4: "da7d67dc9b4a865a361f9b3e6088406fc1e9d49f46d009cee3a2218c00692e5d",
  5: "5b17dbe00458fdf4dab5203f7c118732bf65c076d530043a87e7e29d482c1fae",
  8: "2f616e3dd545d3d0191647b2eca7f99c8a097a94388b979b3a1dcfb099740e8a",
};

async function makePlan(chunkSize: number): Promise<ChunkedEncryptionPlan> {
  const aesKey = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"],
  );
  return {
    aesKey,
    litWrappedKey: { ciphertext: "stub" },
    accs: [],
    chunkSize,
    chunkCount: 0,
    originalSize: 0,
    originalName: "t.bin",
    originalType: "application/octet-stream",
  };
}

describe("computeMerkleRoot — marketplace conformance", () => {
  it.each(Object.keys(REFERENCE_ROOTS).map(Number))(
    "matches the reference root for %i chunk hashes",
    async (count) => {
      const hashes = Array.from({ length: count }, (_, i) => h(i + 1));
      expect(await computeMerkleRoot(hashes)).toBe(REFERENCE_ROOTS[count]);
    },
  );

  it("returns an empty string for no chunks", async () => {
    expect(await computeMerkleRoot([])).toBe("");
  });

  it("returns the lone hash unchanged for a single chunk", async () => {
    expect(await computeMerkleRoot([h(7)])).toBe(h(7));
  });

  it("duplicates the odd trailing node rather than promoting it", async () => {
    // A 3-leaf tree must differ from [a,b,c,c] only in that it *is* [a,b,c,c];
    // promoting c unchanged would give a different root.
    const three = await computeMerkleRoot([h(1), h(2), h(3)]);
    const four = await computeMerkleRoot([h(1), h(2), h(3), h(3)]);
    expect(three).toBe(four);
  });
});

describe("chunk encryption", () => {
  it("round-trips through the pinned wire format", async () => {
    const chunkSize = 1024;
    const plan = await makePlan(chunkSize);
    const original = Buffer.from(
      Array.from({ length: 3500 }, (_, i) => i % 251),
    );
    const count = Math.ceil(original.length / chunkSize);

    const parts: Buffer[] = [];
    for (let i = 0; i < count; i++) {
      const chunk = await encryptChunkAt(original, i, plan);
      // Exactly what gets pinned: [12-byte IV][ciphertext].
      const wire = packChunk(chunk);
      expect(wire.length).toBe(IV_LENGTH + chunk.ciphertext.length);

      const iv = wire.subarray(0, IV_LENGTH);
      const ciphertext = wire.subarray(IV_LENGTH);
      const plain = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: iv as unknown as ArrayBuffer },
        plan.aesKey,
        ciphertext as unknown as ArrayBuffer,
      );
      parts.push(Buffer.from(plain));
    }

    expect(Buffer.concat(parts).equals(original)).toBe(true);
  });

  it("hashes the ciphertext only, never iv || ciphertext", async () => {
    const plan = await makePlan(4096);
    const content = Buffer.alloc(100, 7);
    const chunk = await encryptChunkAt(content, 0, plan);

    const ofCiphertext = Buffer.from(
      await crypto.subtle.digest("SHA-256", chunk.ciphertext as unknown as ArrayBuffer),
    ).toString("hex");
    const ofWire = Buffer.from(
      await crypto.subtle.digest("SHA-256", packChunk(chunk) as unknown as ArrayBuffer),
    ).toString("hex");

    expect(chunk.hash).toBe(ofCiphertext);
    expect(chunk.hash).not.toBe(ofWire);
  });

  it("uses a fresh IV per chunk", async () => {
    const plan = await makePlan(16);
    const content = Buffer.alloc(64, 1);
    const ivs = new Set<string>();
    for (let i = 0; i < 4; i++) {
      const chunk = await encryptChunkAt(content, i, plan);
      ivs.add(Buffer.from(chunk.iv).toString("hex"));
    }
    expect(ivs.size).toBe(4);
  });

  it("produces a final short chunk rather than padding", async () => {
    const plan = await makePlan(1000);
    const content = Buffer.alloc(1500, 3);
    const last = await encryptChunkAt(content, 1, plan);
    // AES-GCM adds a 16-byte tag and no padding.
    expect(last.ciphertext.length).toBe(500 + 16);
  });
});

describe("chunk sizing", () => {
  const MB = 1024 * 1024;

  it("uses 1 MB up to and including 64 MB", () => {
    expect(pickChunkSize(1)).toBe(MB);
    expect(pickChunkSize(64 * MB)).toBe(MB);
  });

  it("steps to 4 MB above 64 MB and up to 512 MB", () => {
    expect(pickChunkSize(64 * MB + 1)).toBe(4 * MB);
    expect(pickChunkSize(512 * MB)).toBe(4 * MB);
  });

  it("caps at 8 MB beyond 512 MB", () => {
    expect(pickChunkSize(512 * MB + 1)).toBe(8 * MB);
    expect(pickChunkSize(2048 * MB)).toBe(8 * MB);
  });
});

describe("envelope", () => {
  it("carries the v2 markers the marketplace reader keys off", async () => {
    const plan = await makePlan(1024);
    plan.originalSize = 2048;
    plan.originalName = "model.safetensors";
    plan.originalType = "application/octet-stream";

    const env = buildEnvelope(plan, ["cidA", "cidB"], [h(1), h(2)], `0x${h(9)}`);

    expect(env.version).toBe(ENVELOPE_VERSION);
    expect(env.version).toBe("chunked-aes-lit-v2");
    expect(env.chunkFormat).toBe(CHUNK_FORMAT_RAW_IV_PREFIXED);
    expect(env.ivLength).toBe(12);
    expect(env.chunkCount).toBe(2);
    expect(env.chunkSize).toBe(1024);
    expect(env.merkleRoot.startsWith("0x")).toBe(true);
    expect(env.originalName).toBe("model.safetensors");
  });

  it("keeps the NFT metadata version distinct from the envelope version", () => {
    // PublishPage.tsx writes v1 into NFT metadata and v2 into the envelope.
    // Collapsing them would make JoyCreate assets differ from marketplace ones.
    expect(METADATA_ENCRYPTION_VERSION).toBe("chunked-aes-lit-v1");
    expect(ENVELOPE_VERSION).toBe("chunked-aes-lit-v2");
  });
});

describe("lit chain naming", () => {
  it("maps the supported chain ids", () => {
    expect(getLitChainName(421614)).toBe("arbitrumSepolia");
    expect(getLitChainName(42161)).toBe("arbitrum");
  });

  it("falls back to Arbitrum Sepolia for unknown or missing ids", () => {
    expect(getLitChainName(undefined)).toBe("arbitrumSepolia");
    expect(getLitChainName(1)).toBe("arbitrumSepolia");
  });
});
