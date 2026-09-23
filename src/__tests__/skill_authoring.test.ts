import { describe, it, expect, vi, beforeEach } from "vitest";
import { ethers } from "ethers";

const { getAgentMock, updateAgentMock } = vi.hoisted(() => ({
  getAgentMock: vi.fn(),
  updateAgentMock: vi.fn(),
}));

vi.mock("@/lib/onchain/erc8004_client", () => ({
  getAgent: getAgentMock,
  updateAgent: updateAgentMock,
}));

import {
  buildSkillBundle,
  authorAndPinSkill,
  publishSkillToAgent,
  type AuthorSkillInput,
} from "@/lib/onchain/skill_authoring";

const CARD_CID = "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG";
const NEW_SKILL_CID = "QmSkill5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdHaa";
const NEW_CARD_CID = "QmCard55CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdHbb";

const PROMPT_SKILL: AuthorSkillInput = {
  kind: "prompt-agent",
  modelId: "llama3",
  systemPrompt: "You are helpful.",
  promptTemplate: "Answer: {{input}}",
};

const EXISTING_CARD = {
  name: "store",
  version: "1.0",
  platform: "JoyCreate",
  type: "agent",
  identity: { storeLabel: "store", owner: "0xabc" },
  chainId: 421614,
  modelConfig: null,
  systemPrompt: null,
  toolsSchema: null,
  skillCID: null,
};

describe("buildSkillBundle", () => {
  it("validates and normalizes a prompt-agent", () => {
    const b = buildSkillBundle(PROMPT_SKILL);
    expect(b.kind).toBe("prompt-agent");
    expect(b.schema).toBe("joy-skill/1.0");
  });

  it("clamps a code-agent's caps via the runtime validator", () => {
    const b = buildSkillBundle({ kind: "code-agent", code: "return 1;", timeoutMs: 999999 });
    if (b.kind === "code-agent") expect(b.timeoutMs).toBe(30_000);
  });

  it("rejects an invalid tool name", () => {
    expect(() =>
      buildSkillBundle({
        kind: "tool-agent",
        modelId: "llama3",
        systemPrompt: "x",
        tools: ["bad-name"],
      }),
    ).toThrow(/invalid tool name/);
  });
});

describe("authorAndPinSkill", () => {
  it("pins the validated bundle and returns the CID", async () => {
    const pinJson = vi.fn().mockResolvedValue({ cid: NEW_SKILL_CID, pinnedRemotely: true });
    const res = await authorAndPinSkill(PROMPT_SKILL, { pinJson });
    expect(res.skillCid).toBe(NEW_SKILL_CID);
    expect(res.skillUri).toBe(`ipfs://${NEW_SKILL_CID}`);
    expect(pinJson).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "prompt-agent", schema: "joy-skill/1.0" }),
      "skill-prompt-agent",
    );
  });
});

describe("publishSkillToAgent", () => {
  let wallet: ethers.Wallet;

  beforeEach(() => {
    vi.clearAllMocks();
    wallet = ethers.Wallet.createRandom();
  });

  it("authors → pins → attaches → re-pins → updates the agentDomain", async () => {
    getAgentMock.mockResolvedValue({
      agentId: "1",
      agentDomain: `ipfs://${CARD_CID}`,
      agentAddress: wallet.address,
    });
    updateAgentMock.mockResolvedValue({ txHash: "0xtx" });
    const fetchJson = vi.fn().mockResolvedValue({ ...EXISTING_CARD });
    const pinJson = vi
      .fn()
      .mockResolvedValueOnce({ cid: NEW_SKILL_CID, pinnedRemotely: true })
      .mockResolvedValueOnce({ cid: NEW_CARD_CID, pinnedRemotely: true });

    const res = await publishSkillToAgent(
      wallet,
      { chain: "arbitrumSepolia", agentId: "1", skill: PROMPT_SKILL },
      { fetchJson, pinJson },
    );

    expect(res.skillCid).toBe(NEW_SKILL_CID);
    expect(res.cardCid).toBe(NEW_CARD_CID);
    expect(res.txHash).toBe("0xtx");
    // Card re-pinned with the new skillCID embedded.
    expect(pinJson).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ skillCID: NEW_SKILL_CID }),
      expect.stringContaining("agent-card"),
    );
    // agentDomain updated to the new card CID.
    expect(updateAgentMock).toHaveBeenCalledWith(
      wallet,
      expect.objectContaining({ agentId: "1", newDomain: NEW_CARD_CID, newAddress: wallet.address }),
    );
  });

  it("refuses when the wallet does not control the agent", async () => {
    getAgentMock.mockResolvedValue({
      agentId: "1",
      agentDomain: `ipfs://${CARD_CID}`,
      agentAddress: "0x000000000000000000000000000000000000dEaD",
    });
    const pinJson = vi.fn().mockResolvedValue({ cid: NEW_SKILL_CID, pinnedRemotely: true });
    await expect(
      publishSkillToAgent(
        wallet,
        { chain: "arbitrumSepolia", agentId: "1", skill: PROMPT_SKILL },
        { fetchJson: vi.fn(), pinJson },
      ),
    ).rejects.toThrow(/does not control agent/);
    expect(updateAgentMock).not.toHaveBeenCalled();
  });

  it("builds a fresh card when the agent has no card CID", async () => {
    getAgentMock.mockResolvedValue({
      agentId: "2",
      agentDomain: "legacy.example.com",
      agentAddress: wallet.address,
    });
    updateAgentMock.mockResolvedValue({ txHash: "0xtx2" });
    const fetchJson = vi.fn();
    const pinJson = vi
      .fn()
      .mockResolvedValueOnce({ cid: NEW_SKILL_CID, pinnedRemotely: true })
      .mockResolvedValueOnce({ cid: NEW_CARD_CID, pinnedRemotely: true });

    const res = await publishSkillToAgent(
      wallet,
      { chain: "arbitrumSepolia", agentId: "2", skill: PROMPT_SKILL, cardName: "my-agent" },
      { fetchJson, pinJson },
    );

    expect(res.cardCid).toBe(NEW_CARD_CID);
    // No existing card was fetched (agentDomain wasn't a CID).
    expect(fetchJson).not.toHaveBeenCalled();
    // The freshly-built card carries the new skillCID.
    expect(pinJson).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ name: "my-agent", skillCID: NEW_SKILL_CID }),
      expect.stringContaining("agent-card"),
    );
  });
});
