/**
 * publishAndMonetize — unit tests.
 *
 * The orchestrator bridges publishAndForget (mint) -> EditionController store
 * drop -> ERC-1144 blueprint. We mock every on-chain dependency so no RPC is
 * touched, and assert the glue wiring:
 *   - happy path on Arbitrum Sepolia mints + auto-registers store + creates drop
 *   - an existing store is reused (no auto-register)
 *   - the USDC atomic price + merkle-root asset leaf are forwarded to createDrop
 *   - a non-hex assetLeafSource is keccak-hashed
 *   - dryRun skips all on-chain writes
 *   - a non-glue-ready Arbitrum chain (arbitrumOne) skips the drop with an error
 *   - a failed mint skips the drop
 *   - a missing store slug skips the drop with an actionable error
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { ethers } from "ethers";

vi.mock("electron-log", () => ({
  default: {
    scope: () => ({ info: () => undefined, warn: () => undefined, error: () => undefined }),
  },
}));

vi.mock("@/lib/jcn_key_manager", () => ({
  jcnKeyManager: {
    initialize: vi.fn(async () => undefined),
    listKeys: vi.fn(async () => [
      { keyId: "k1", active: true, algorithm: "secp256k1" },
    ]),
    getPrivateKey: vi.fn(async () =>
      Buffer.from(
        "59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
        "hex",
      ),
    ),
  },
}));

vi.mock("@/config/glue", () => ({
  GLUE_RPC: {
    arbitrumSepolia: "http://localhost:8545",
    arbitrumOne: "http://localhost:8546",
  },
  isGlueReady: vi.fn((chain: string) => chain === "arbitrumSepolia"),
}));

vi.mock("@/config/x402", () => ({
  usdcToAtomic: (v: string) => BigInt(Math.round(parseFloat(v) * 1_000_000)),
}));

vi.mock("@/lib/onchain/chain_registry", () => ({
  DEFAULT_MARKETPLACE_CHAIN: "arbitrumSepolia",
}));

vi.mock("@/lib/onchain/glue_client", () => ({
  resolveStoreBySlug: vi.fn(async () => "0"),
  registerStore: vi.fn(async () => ({
    storeId: "42",
    txHash: "0xreg",
    blockNumber: 1,
  })),
  createDrop: vi.fn(async () => ({ dropId: "7", txHash: "0xdrop", blockNumber: 2 })),
}));

vi.mock("@/lib/onchain/interface_broker", () => ({
  buildDropBlueprint: vi.fn(async () => ({ id: "bp-7" })),
}));

vi.mock("@/lib/onchain/agent_card", () => ({
  ensureStoreIdentity: vi.fn(async () => ({
    agentId: "5",
    agentCardCid: "bafycard",
    agentCardUri: "ipfs://bafycard",
    minted: true,
    reused: false,
    txHash: "0xid",
  })),
}));

vi.mock("@/main/settings", () => ({
  readSettings: vi.fn(() => ({
    marketplaceChain: "arbitrumSepolia",
    marketplaceStoreSlug: "my-store",
  })),
}));

vi.mock("@/lib/joymarketplace/publish_orchestrator", () => ({
  publishAndForget: vi.fn(),
}));

import { publishAndForget } from "@/lib/joymarketplace/publish_orchestrator";
import {
  resolveStoreBySlug,
  registerStore,
  createDrop,
} from "@/lib/onchain/glue_client";
import { buildDropBlueprint } from "@/lib/onchain/interface_broker";
import { ensureStoreIdentity } from "@/lib/onchain/agent_card";
import { isGlueReady } from "@/config/glue";
import { readSettings } from "@/main/settings";
import { publishAndMonetize } from "@/lib/joymarketplace/publish_and_monetize";

const MERKLE_ROOT = `0x${"ab".repeat(32)}`;

function mintedOutcome(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    dryRun: false,
    errors: [],
    tokenId: "123",
    merkleRoot: MERKLE_ROOT,
    contentHash: "0xdeadbeef",
    contentCid: "bafycontent",
    marketplaceUrl: "https://joymarketplace.io/asset/123",
    ...overrides,
  };
}

function basePublishInput() {
  return {
    assetType: "app" as const,
    name: "Test App",
    contentBuffer: Buffer.from("zip-bytes"),
    contentMimeType: "application/zip",
  };
}

describe("publishAndMonetize", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isGlueReady).mockImplementation(
      (chain: string) => chain === "arbitrumSepolia",
    );
    vi.mocked(readSettings).mockReturnValue({
      marketplaceChain: "arbitrumSepolia",
      marketplaceStoreSlug: "my-store",
    } as unknown as ReturnType<typeof readSettings>);
    vi.mocked(resolveStoreBySlug).mockResolvedValue("0");
    vi.mocked(registerStore).mockResolvedValue({
      storeId: "42",
      txHash: "0xreg",
      blockNumber: 1,
    });
    vi.mocked(createDrop).mockResolvedValue({
      dropId: "7",
      txHash: "0xdrop",
      blockNumber: 2,
    });
    vi.mocked(buildDropBlueprint).mockResolvedValue({
      id: "bp-7",
    } as unknown as Awaited<ReturnType<typeof buildDropBlueprint>>);
    vi.mocked(ensureStoreIdentity).mockResolvedValue({
      agentId: "5",
      agentCardCid: "bafycard",
      agentCardUri: "ipfs://bafycard",
      minted: true,
      reused: false,
      txHash: "0xid",
    });
  });

  it("mints, auto-registers the store, and creates the drop on Arbitrum Sepolia", async () => {
    vi.mocked(publishAndForget).mockResolvedValue(mintedOutcome());

    const outcome = await publishAndMonetize({
      publish: basePublishInput(),
      priceUsdc: 1.5,
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.dryRun).toBe(false);
    expect(outcome.chain).toBe("arbitrumSepolia");
    expect(outcome.storeId).toBe("42");
    expect(outcome.storeRegistered).toBe(true);
    expect(outcome.agentId).toBe("5");
    expect(outcome.agentCardCid).toBe("bafycard");
    expect(outcome.dropId).toBe("7");
    expect(outcome.dropTxHash).toBe("0xdrop");
    expect(outcome.blueprint).toBeDefined();
    expect(outcome.marketplaceUrl).toBe("https://joymarketplace.io/asset/123");
    expect(outcome.errors).toEqual([]);

    // Store resolved/registered under the configured slug; the freshly minted
    // ERC-8004 identity is bound to the store.
    expect(resolveStoreBySlug).toHaveBeenCalledWith("arbitrumSepolia", "my-store");
    expect(ensureStoreIdentity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        chain: "arbitrumSepolia",
        slug: "my-store",
        type: "store",
      }),
    );
    expect(registerStore).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        chain: "arbitrumSepolia",
        slug: "my-store",
        agentId: "5",
      }),
    );

    // Drop is created with the USDC atomic price and the merkle-root asset leaf.
    expect(createDrop).toHaveBeenCalledTimes(1);
    const dropArgs = vi.mocked(createDrop).mock.calls[0][1];
    expect(dropArgs.price).toBe("1500000");
    expect(dropArgs.assetLeaf).toBe(MERKLE_ROOT);
    expect(dropArgs.storeId).toBe("42");

    // publishAndForget receives the atomic price + default royalty + slug.
    const pubArgs = vi.mocked(publishAndForget).mock.calls[0][0];
    expect(pubArgs.priceUsdc).toBe(1_500_000);
    expect(pubArgs.royaltyBps).toBe(250);
    expect(pubArgs.storeSlug).toBe("my-store");

    expect(buildDropBlueprint).toHaveBeenCalledWith(
      "arbitrumSepolia",
      "7",
      expect.objectContaining({ license: expect.objectContaining({ id: expect.any(String) }) }),
    );
  });

  it("reuses an existing store without auto-registering", async () => {
    vi.mocked(publishAndForget).mockResolvedValue(mintedOutcome());
    vi.mocked(resolveStoreBySlug).mockResolvedValue("99");

    const outcome = await publishAndMonetize({
      publish: basePublishInput(),
      priceUsdc: 2,
    });

    expect(outcome.storeId).toBe("99");
    expect(outcome.storeRegistered).toBe(false);
    expect(registerStore).not.toHaveBeenCalled();
    // No new store -> no identity mint.
    expect(ensureStoreIdentity).not.toHaveBeenCalled();
    expect(createDrop).toHaveBeenCalledTimes(1);
    expect(vi.mocked(createDrop).mock.calls[0][1].storeId).toBe("99");
  });

  it("registers the store without an identity when minting fails", async () => {
    vi.mocked(publishAndForget).mockResolvedValue(mintedOutcome());
    vi.mocked(ensureStoreIdentity).mockRejectedValue(
      new Error("ERC-8004 registries not deployed"),
    );

    const outcome = await publishAndMonetize({
      publish: basePublishInput(),
      priceUsdc: 1,
    });

    // Store still registers (with agent id "0") and the drop still lands.
    expect(registerStore).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ slug: "my-store", agentId: "0" }),
    );
    expect(outcome.storeRegistered).toBe(true);
    expect(outcome.agentId).toBeUndefined();
    expect(outcome.dropId).toBe("7");
    expect(outcome.errors.some((e) => /identity:/.test(e))).toBe(true);
  });

  it("uses an explicit agentId without minting a new identity", async () => {
    vi.mocked(publishAndForget).mockResolvedValue(mintedOutcome());

    await publishAndMonetize({
      publish: basePublishInput(),
      priceUsdc: 1,
      agentId: "77",
    });

    expect(ensureStoreIdentity).not.toHaveBeenCalled();
    expect(registerStore).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ slug: "my-store", agentId: "77" }),
    );
  });

  it("keccak-hashes a non-hex assetLeafSource", async () => {
    vi.mocked(publishAndForget).mockResolvedValue(mintedOutcome());

    await publishAndMonetize({
      publish: basePublishInput(),
      priceUsdc: 1,
      assetLeafSource: "model-content-sha-not-hex",
    });

    const expected = ethers.keccak256(
      ethers.toUtf8Bytes("model-content-sha-not-hex"),
    );
    expect(vi.mocked(createDrop).mock.calls[0][1].assetLeaf).toBe(expected);
  });

  it("dry-run skips all on-chain writes", async () => {
    vi.mocked(publishAndForget).mockResolvedValue(
      mintedOutcome({ dryRun: true }),
    );

    const outcome = await publishAndMonetize({
      publish: basePublishInput(),
      priceUsdc: 1.5,
      dryRun: true,
    });

    expect(outcome.dryRun).toBe(true);
    expect(outcome.dropId).toBeUndefined();
    expect(outcome.storeRegistered).toBe(false);
    expect(resolveStoreBySlug).not.toHaveBeenCalled();
    expect(registerStore).not.toHaveBeenCalled();
    expect(createDrop).not.toHaveBeenCalled();
  });

  it("skips the drop with an error when the Arbitrum chain is not glue-ready", async () => {
    vi.mocked(publishAndForget).mockResolvedValue(mintedOutcome());

    const outcome = await publishAndMonetize({
      publish: basePublishInput(),
      chain: "arbitrumOne",
      priceUsdc: 1.5,
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.chain).toBe("arbitrumOne");
    expect(outcome.dropId).toBeUndefined();
    expect(createDrop).not.toHaveBeenCalled();
    expect(outcome.errors.some((e) => /not deployed on arbitrumOne/.test(e))).toBe(
      true,
    );
  });

  it("skips the drop when the mint did not land on chain", async () => {
    vi.mocked(publishAndForget).mockResolvedValue(
      mintedOutcome({ ok: false, blockedAt: "no-gate", errors: ["no-gate"] }),
    );

    const outcome = await publishAndMonetize({
      publish: basePublishInput(),
      priceUsdc: 1.5,
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.dropId).toBeUndefined();
    expect(createDrop).not.toHaveBeenCalled();
    expect(outcome.errors).toContain("no-gate");
  });

  it("skips the drop with an actionable error when no store slug is configured", async () => {
    vi.mocked(publishAndForget).mockResolvedValue(mintedOutcome());
    vi.mocked(readSettings).mockReturnValue({
      marketplaceChain: "arbitrumSepolia",
    } as unknown as ReturnType<typeof readSettings>);

    const outcome = await publishAndMonetize({
      publish: basePublishInput(),
      priceUsdc: 1.5,
    });

    expect(outcome.dropId).toBeUndefined();
    expect(createDrop).not.toHaveBeenCalled();
    expect(outcome.errors.some((e) => /no store slug configured/.test(e))).toBe(
      true,
    );
  });
});
