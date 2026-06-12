/**
 * store_identity — LR6 / G6 ENS ↔ slug unification unit tests.
 *
 * Mocks glue_client / erc8004_client / ens_hierarchical so no chain is touched,
 * then asserts the slug → name canonical direction and the reconciliation
 * (unified / mismatch / unresolved) branches.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("electron-log", () => ({
  default: {
    scope: () => ({ info: () => undefined, warn: () => undefined, error: () => undefined }),
  },
}));

vi.mock("@/lib/onchain/glue_client", () => ({
  getStore: vi.fn(),
  makeProvider: vi.fn(() => ({})),
}));

vi.mock("@/lib/onchain/erc8004_client", () => ({
  getAgent: vi.fn(),
}));

vi.mock("@/lib/onchain/ens_hierarchical", () => ({
  resolveAddress: vi.fn(),
  storeName: (slug: string) => `${slug}.store.marketplace.eth`,
}));

import { getStore } from "@/lib/onchain/glue_client";
import { getAgent } from "@/lib/onchain/erc8004_client";
import { resolveAddress } from "@/lib/onchain/ens_hierarchical";
import { canonicalStoreName, reconcileStoreIdentity } from "@/lib/onchain/store_identity";

const ARB = "arbitrumSepolia" as never;

beforeEach(() => vi.clearAllMocks());

describe("canonicalStoreName", () => {
  it("derives the ENS name from the slug (slug → name)", () => {
    expect(canonicalStoreName("acme")).toBe("acme.store.marketplace.eth");
  });
});

describe("reconcileStoreIdentity", () => {
  it("is unified when the ENS name resolves to the agent address", async () => {
    (getStore as ReturnType<typeof vi.fn>).mockResolvedValue({
      storeId: "7",
      owner: "0xOwner",
      agentId: "3",
      slug: "acme",
    });
    (getAgent as ReturnType<typeof vi.fn>).mockResolvedValue({
      agentId: "3",
      agentAddress: "0xAgent",
      agentDomain: "acme.example",
    });
    (resolveAddress as ReturnType<typeof vi.fn>).mockResolvedValue("0xagent");

    const res = await reconcileStoreIdentity(ARB, "7");

    expect(res.unified).toBe(true);
    expect(res.ensName).toBe("acme.store.marketplace.eth");
    expect(res.expectedAddress).toBe("0xAgent");
    expect(res.reason).toBeUndefined();
  });

  it("falls back to the owner address when the store has no agent", async () => {
    (getStore as ReturnType<typeof vi.fn>).mockResolvedValue({
      storeId: "7",
      owner: "0xOwner",
      agentId: "0",
      slug: "acme",
    });
    (resolveAddress as ReturnType<typeof vi.fn>).mockResolvedValue("0xowner");

    const res = await reconcileStoreIdentity(ARB, "7");

    expect(getAgent).not.toHaveBeenCalled();
    expect(res.expectedAddress).toBe("0xOwner");
    expect(res.unified).toBe(true);
  });

  it("reports a mismatch when the name resolves elsewhere", async () => {
    (getStore as ReturnType<typeof vi.fn>).mockResolvedValue({
      storeId: "7",
      owner: "0xOwner",
      agentId: "0",
      slug: "acme",
    });
    (resolveAddress as ReturnType<typeof vi.fn>).mockResolvedValue("0xSomeoneElse");

    const res = await reconcileStoreIdentity(ARB, "7");

    expect(res.unified).toBe(false);
    expect(res.reason).toContain("expected");
  });

  it("reports unresolved when the name has no address record", async () => {
    (getStore as ReturnType<typeof vi.fn>).mockResolvedValue({
      storeId: "7",
      owner: "0xOwner",
      agentId: "0",
      slug: "acme",
    });
    (resolveAddress as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const res = await reconcileStoreIdentity(ARB, "7");

    expect(res.unified).toBe(false);
    expect(res.resolvedAddress).toBeNull();
    expect(res.reason).toContain("no address record");
  });
});
