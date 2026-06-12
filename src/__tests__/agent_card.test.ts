/**
 * agent_card — unit tests for the pure builders.
 *
 * `ensureStoreIdentity` / `pinAgentCard` touch IPFS + chain and are covered via
 * publish_and_monetize integration; here we assert the pure, deterministic
 * pieces: card shape and CID recognition.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("electron-log", () => ({
  default: {
    scope: () => ({ info: () => undefined, warn: () => undefined, error: () => undefined }),
  },
}));

import {
  AGENT_CARD_PLATFORM,
  AGENT_CARD_VERSION,
  agentDomainToCardCid,
  buildAgentCard,
} from "@/lib/onchain/agent_card";

describe("buildAgentCard", () => {
  it("builds a store card with null runtime fields by default", () => {
    const card = buildAgentCard({
      name: "my-store",
      owner: "0x1111111111111111111111111111111111111111",
      chain: "arbitrumSepolia",
    });

    expect(card).toEqual({
      name: "my-store",
      version: AGENT_CARD_VERSION,
      platform: AGENT_CARD_PLATFORM,
      type: "store",
      modelConfig: null,
      systemPrompt: null,
      toolsSchema: null,
      skillCID: null,
      identity: {
        storeLabel: "my-store",
        owner: "0x1111111111111111111111111111111111111111",
      },
      chainId: 421614,
    });
  });

  it("carries runtime manifest overrides", () => {
    const card = buildAgentCard({
      name: "agent-1",
      type: "agent",
      owner: "0x2222222222222222222222222222222222222222",
      chain: "arbitrumSepolia",
      runtime: {
        systemPrompt: "You are helpful.",
        skillCID: "bafkskill",
      },
    });

    expect(card.type).toBe("agent");
    expect(card.systemPrompt).toBe("You are helpful.");
    expect(card.skillCID).toBe("bafkskill");
    expect(card.modelConfig).toBeNull();
    expect(card.toolsSchema).toBeNull();
  });
});

describe("agentDomainToCardCid", () => {
  it("recognizes a CIDv0 (Qm…) domain", () => {
    const cid = "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG";
    expect(agentDomainToCardCid(cid)).toBe(cid);
  });

  it("recognizes a CIDv1 (bafy…) domain and strips ipfs://", () => {
    const cid = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
    expect(agentDomainToCardCid(`ipfs://${cid}`)).toBe(cid);
  });

  it("returns undefined for a legacy plain-text domain", () => {
    expect(agentDomainToCardCid("my-store.joy")).toBeUndefined();
    expect(agentDomainToCardCid("")).toBeUndefined();
    expect(agentDomainToCardCid(undefined)).toBeUndefined();
  });
});
