/**
 * reputation — LR3 post-purchase feedback unit tests.
 *
 * Mocks the ERC-8004 client so no RPC is touched, then asserts the two-sided
 * accept/submit policy and the benign-skip branches.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { ethers } from "ethers";

vi.mock("electron-log", () => ({
  default: {
    scope: () => ({ info: () => undefined, warn: () => undefined, error: () => undefined }),
  },
}));

vi.mock("@/config/erc8004", () => ({}));

vi.mock("@/lib/onchain/erc8004_client", () => ({
  resolveByAddress: vi.fn(),
  isFeedbackAuthorized: vi.fn(),
  getAgent: vi.fn(),
  acceptFeedback: vi.fn(),
  submitFeedback: vi.fn(),
}));

import {
  resolveByAddress,
  isFeedbackAuthorized,
  getAgent,
  acceptFeedback,
  submitFeedback,
} from "@/lib/onchain/erc8004_client";
import {
  DEFAULT_PURCHASE_SCORE,
  buildFeedbackReceipt,
  submitPurchaseFeedback,
} from "@/lib/onchain/reputation";

const WALLET_ADDR = "0x1111111111111111111111111111111111111111";
const wallet = { address: WALLET_ADDR } as unknown as ethers.Wallet;

const baseInput = {
  chain: "arbitrumSepolia" as never,
  serverId: "9",
  buyer: "0x2222222222222222222222222222222222222222",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolveByAddress).mockResolvedValue("3");
  vi.mocked(isFeedbackAuthorized).mockResolvedValue(true);
  vi.mocked(submitFeedback).mockResolvedValue({ txHash: "0xfeedback" });
  vi.mocked(acceptFeedback).mockResolvedValue({ txHash: "0xaccept" });
});

describe("buildFeedbackReceipt", () => {
  it("builds a versioned receipt with a clamped default score", () => {
    const receipt = buildFeedbackReceipt({
      dropId: "7",
      tokenId: "1",
      buyer: baseInput.buyer,
      creator: "0xcreator",
      amountAtomic: "1500000",
    });
    expect(receipt.schema).toBe("joy-feedback/1.0");
    expect(receipt.score).toBe(DEFAULT_PURCHASE_SCORE);
    expect(receipt.settlementTxHash).toBeNull();
    expect(receipt.issuedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("clamps an out-of-range score", () => {
    expect(buildFeedbackReceipt({
      dropId: "7", tokenId: "1", buyer: "0x", creator: "0x", amountAtomic: "0", score: 250,
    }).score).toBe(100);
  });
});

describe("submitPurchaseFeedback", () => {
  it("submits when already authorized", async () => {
    const result = await submitPurchaseFeedback(wallet, baseInput);
    expect(result.submitted).toBe(true);
    expect(result.skipped).toBe(false);
    expect(result.txHash).toBe("0xfeedback");
    expect(result.clientId).toBe("3");
    expect(acceptFeedback).not.toHaveBeenCalled();
    expect(submitFeedback).toHaveBeenCalledWith(
      wallet,
      expect.objectContaining({ clientId: "3", serverId: "9", score: 100 }),
    );
  });

  it("skips when the store has no serving agent", async () => {
    const result = await submitPurchaseFeedback(wallet, { ...baseInput, serverId: "0" });
    expect(result.skipped).toBe(true);
    expect(result.reason).toContain("serving agent identity");
    expect(resolveByAddress).not.toHaveBeenCalled();
  });

  it("skips when the buyer has no agent identity", async () => {
    vi.mocked(resolveByAddress).mockResolvedValue("0");
    const result = await submitPurchaseFeedback(wallet, baseInput);
    expect(result.skipped).toBe(true);
    expect(result.reason).toContain("clientId");
    expect(submitFeedback).not.toHaveBeenCalled();
  });

  it("skips self-feedback when buyer is the serving agent", async () => {
    vi.mocked(resolveByAddress).mockResolvedValue("9");
    const result = await submitPurchaseFeedback(wallet, baseInput);
    expect(result.skipped).toBe(true);
    expect(result.reason).toContain("self-feedback");
  });

  it("auto-accepts then submits when this wallet owns the serving agent", async () => {
    vi.mocked(isFeedbackAuthorized).mockResolvedValue(false);
    vi.mocked(getAgent).mockResolvedValue({
      agentId: "9",
      agentDomain: "store.eth",
      agentAddress: WALLET_ADDR,
    } as never);
    const result = await submitPurchaseFeedback(wallet, baseInput);
    expect(acceptFeedback).toHaveBeenCalledWith(
      wallet,
      expect.objectContaining({ clientId: "3", serverId: "9" }),
    );
    expect(result.submitted).toBe(true);
    expect(result.acceptTxHash).toBe("0xaccept");
  });

  it("skips when not authorized and this wallet does not own the serving agent", async () => {
    vi.mocked(isFeedbackAuthorized).mockResolvedValue(false);
    vi.mocked(getAgent).mockResolvedValue({
      agentId: "9",
      agentDomain: "store.eth",
      agentAddress: "0x9999999999999999999999999999999999999999",
    } as never);
    const result = await submitPurchaseFeedback(wallet, baseInput);
    expect(result.skipped).toBe(true);
    expect(result.reason).toContain("not authorized");
    expect(acceptFeedback).not.toHaveBeenCalled();
    expect(submitFeedback).not.toHaveBeenCalled();
  });
});
