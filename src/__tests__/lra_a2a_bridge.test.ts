import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  bridgeIdentityToA2a,
  readListingBinding,
  LRA_RUNTIME_CAPABILITY,
  LRA_BINDING_KEY,
  type BridgeDeps,
} from "@/lib/onchain/lra_a2a_bridge";
import type { AgentServiceListingRow } from "@/db/a2a_schema";

const PRINCIPAL = {
  id: "principal-1",
  agentId: 7,
  did: "did:joy:abc",
  payoutWallet: "0xcontroller",
};

function makeDeps(overrides: Partial<BridgeDeps> = {}): {
  deps: BridgeDeps;
  getOrCreatePrincipal: ReturnType<typeof vi.fn>;
  updatePrincipalPayoutWallet: ReturnType<typeof vi.fn>;
  listListings: ReturnType<typeof vi.fn>;
  createListing: ReturnType<typeof vi.fn>;
} {
  const getOrCreatePrincipal = vi.fn().mockResolvedValue(PRINCIPAL);
  const updatePrincipalPayoutWallet = vi.fn().mockResolvedValue(PRINCIPAL);
  const listListings = vi.fn().mockResolvedValue([]);
  const createListing = vi
    .fn()
    .mockImplementation(async (input: Record<string, unknown>) => ({
      id: "listing-1",
      ...input,
    }));
  const deps: BridgeDeps = {
    getOrCreatePrincipal: getOrCreatePrincipal as never,
    updatePrincipalPayoutWallet: updatePrincipalPayoutWallet as never,
    listListings: listListings as never,
    createListing: createListing as never,
    ...overrides,
  };
  return { deps, getOrCreatePrincipal, updatePrincipalPayoutWallet, listListings, createListing };
}

const BASE_INPUT = {
  localAgentId: 7,
  erc8004AgentId: "42",
  chain: "arbitrumSepolia" as const,
  agentAddress: "0xcontroller",
  skillCid: "QmSkill",
};

describe("bridgeIdentityToA2a", () => {
  beforeEach(() => vi.clearAllMocks());

  it("ensures a principal and creates a bound lra.runtime listing", async () => {
    const { deps, getOrCreatePrincipal, createListing } = makeDeps();
    const res = await bridgeIdentityToA2a(BASE_INPUT, deps);

    expect(getOrCreatePrincipal).toHaveBeenCalledWith(7, { payoutWallet: "0xcontroller" });
    expect(res.principalId).toBe("principal-1");
    expect(res.did).toBe("did:joy:abc");
    expect(res.capability).toBe(LRA_RUNTIME_CAPABILITY);
    expect(res.createdListing).toBe(true);

    const created = createListing.mock.calls[0][0];
    expect(created.capability).toBe(LRA_RUNTIME_CAPABILITY);
    expect(created.inputSchemaJson[LRA_BINDING_KEY]).toEqual({
      erc8004AgentId: "42",
      chain: "arbitrumSepolia",
      agentAddress: "0xcontroller",
      skillCid: "QmSkill",
    });
  });

  it("reconciles the payout wallet when it differs from the controller", async () => {
    const { deps, updatePrincipalPayoutWallet } = makeDeps({
      getOrCreatePrincipal: vi
        .fn()
        .mockResolvedValue({ ...PRINCIPAL, payoutWallet: "0xstale" }) as never,
    });
    await bridgeIdentityToA2a(BASE_INPUT, deps);
    expect(updatePrincipalPayoutWallet).toHaveBeenCalledWith("principal-1", "0xcontroller");
  });

  it("reuses an existing listing bound to the same on-chain agent", async () => {
    const existing: Partial<AgentServiceListingRow> = {
      id: "listing-existing",
      capability: LRA_RUNTIME_CAPABILITY,
      inputSchemaJson: {
        [LRA_BINDING_KEY]: {
          erc8004AgentId: "42",
          chain: "arbitrumSepolia",
          agentAddress: "0xcontroller",
        },
      },
    };
    const { deps, createListing } = makeDeps({
      listListings: vi.fn().mockResolvedValue([existing]) as never,
    });
    const res = await bridgeIdentityToA2a(BASE_INPUT, deps);
    expect(res.listingId).toBe("listing-existing");
    expect(res.createdListing).toBe(false);
    expect(createListing).not.toHaveBeenCalled();
  });

  it("does not reuse a listing bound to a different agent", async () => {
    const other: Partial<AgentServiceListingRow> = {
      id: "listing-other",
      capability: LRA_RUNTIME_CAPABILITY,
      inputSchemaJson: {
        [LRA_BINDING_KEY]: {
          erc8004AgentId: "99",
          chain: "arbitrumSepolia",
          agentAddress: "0xother",
        },
      },
    };
    const { deps, createListing } = makeDeps({
      listListings: vi.fn().mockResolvedValue([other]) as never,
    });
    const res = await bridgeIdentityToA2a(BASE_INPUT, deps);
    expect(res.createdListing).toBe(true);
    expect(createListing).toHaveBeenCalledOnce();
  });

  it("rejects an invalid localAgentId", async () => {
    const { deps } = makeDeps();
    await expect(
      bridgeIdentityToA2a({ ...BASE_INPUT, localAgentId: 0 }, deps),
    ).rejects.toThrow(/localAgentId/);
  });
});

describe("readListingBinding", () => {
  it("returns null when no binding is present", () => {
    expect(readListingBinding({ inputSchemaJson: null } as AgentServiceListingRow)).toBeNull();
    expect(
      readListingBinding({ inputSchemaJson: { type: "object" } } as AgentServiceListingRow),
    ).toBeNull();
  });

  it("parses a valid binding", () => {
    const binding = readListingBinding({
      inputSchemaJson: {
        [LRA_BINDING_KEY]: {
          erc8004AgentId: "42",
          chain: "arbitrumSepolia",
          agentAddress: "0xc",
          skillCid: "QmS",
        },
      },
    } as AgentServiceListingRow);
    expect(binding).toEqual({
      erc8004AgentId: "42",
      chain: "arbitrumSepolia",
      agentAddress: "0xc",
      skillCid: "QmS",
    });
  });
});
