/**
 * subgraph_discovery — LR6 / G6 subgraph-first reads with RPC fallback.
 *
 * Mocks the subgraph config + glue_client so no network/chain is touched, then
 * asserts the subgraph-hit and RPC-fallback paths for stores and drops.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("electron-log", () => ({
  default: {
    scope: () => ({ info: () => undefined, warn: () => undefined, error: () => undefined }),
  },
}));

vi.mock("@/config/subgraphs", () => ({
  GOLDSKY_SUBGRAPHS: {
    arbitrumSepolia: { drop: "", stores: "", marketplace: "https://sg.example/gn" },
    arbitrumOne: { drop: "", stores: "", marketplace: "" },
  },
  querySubgraph: vi.fn(),
}));

vi.mock("@/lib/onchain/glue_client", () => ({
  getStore: vi.fn(),
  getDrop: vi.fn(),
}));

import { querySubgraph } from "@/config/subgraphs";
import { getStore, getDrop } from "@/lib/onchain/glue_client";
import {
  getStoreCached,
  getDropCached,
  hasMarketplaceSubgraph,
} from "@/lib/onchain/subgraph_discovery";

const ARB = "arbitrumSepolia" as never;
const ONE = "arbitrumOne" as never;

beforeEach(() => vi.clearAllMocks());

describe("hasMarketplaceSubgraph", () => {
  it("is true only when an endpoint is configured", () => {
    expect(hasMarketplaceSubgraph(ARB)).toBe(true);
    expect(hasMarketplaceSubgraph(ONE)).toBe(false);
  });
});

describe("getStoreCached", () => {
  it("reads from the subgraph when configured", async () => {
    (querySubgraph as ReturnType<typeof vi.fn>).mockResolvedValue({
      store: { id: "7", owner: "0xOwner", agentId: "3", slug: "shop" },
    });

    const rec = await getStoreCached(ARB, "7");

    expect(rec).toEqual({ storeId: "7", owner: "0xOwner", agentId: "3", slug: "shop" });
    expect(getStore).not.toHaveBeenCalled();
  });

  it("falls back to RPC when the subgraph misses", async () => {
    (querySubgraph as ReturnType<typeof vi.fn>).mockResolvedValue({ store: null });
    (getStore as ReturnType<typeof vi.fn>).mockResolvedValue({
      storeId: "7",
      owner: "0xRpc",
      agentId: "0",
      slug: "rpc",
    });

    const rec = await getStoreCached(ARB, "7");

    expect(rec.owner).toBe("0xRpc");
    expect(getStore).toHaveBeenCalledWith(ARB, "7");
  });

  it("falls back to RPC when the subgraph errors", async () => {
    (querySubgraph as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("boom"));
    (getStore as ReturnType<typeof vi.fn>).mockResolvedValue({
      storeId: "7",
      owner: "0xRpc",
      agentId: "0",
      slug: "rpc",
    });

    const rec = await getStoreCached(ARB, "7");
    expect(rec.owner).toBe("0xRpc");
  });

  it("uses RPC directly when no subgraph is configured", async () => {
    (getStore as ReturnType<typeof vi.fn>).mockResolvedValue({
      storeId: "1",
      owner: "0xRpc",
      agentId: "0",
      slug: "rpc",
    });

    await getStoreCached(ONE, "1");
    expect(querySubgraph).not.toHaveBeenCalled();
    expect(getStore).toHaveBeenCalled();
  });
});

describe("getDropCached", () => {
  it("maps subgraph drop fields, including nested store id", async () => {
    (querySubgraph as ReturnType<typeof vi.fn>).mockResolvedValue({
      drop: {
        id: "12",
        creator: "0xC",
        assetLeaf: "0xleaf",
        price: "1000000",
        maxSupply: "0",
        minted: "4",
        active: true,
        requiresProof: false,
        store: { id: "7" },
      },
    });

    const rec = await getDropCached(ARB, "12");

    expect(rec).toEqual({
      dropId: "12",
      creator: "0xC",
      storeId: "7",
      assetLeaf: "0xleaf",
      price: "1000000",
      maxSupply: "0",
      minted: "4",
      active: true,
      requiresProof: false,
    });
    expect(getDrop).not.toHaveBeenCalled();
  });

  it("falls back to RPC when the subgraph misses", async () => {
    (querySubgraph as ReturnType<typeof vi.fn>).mockResolvedValue({ drop: null });
    (getDrop as ReturnType<typeof vi.fn>).mockResolvedValue({ dropId: "12", storeId: "0" });

    const rec = await getDropCached(ARB, "12");
    expect(rec.dropId).toBe("12");
    expect(getDrop).toHaveBeenCalledWith(ARB, "12");
  });
});
