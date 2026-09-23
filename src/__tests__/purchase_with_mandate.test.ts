/**
 * purchaseEditionWithMandate — LR4 mandate-bounded purchase unit tests.
 *
 * Mocks the x402 client/server + glue client + reputation so no RPC is touched,
 * then asserts the on-chain spend-cap pre-flight and the recordSpend charge.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { ethers } from "ethers";

vi.mock("electron-log", () => ({
  default: {
    scope: () => ({ info: () => undefined, warn: () => undefined, error: () => undefined }),
  },
}));

vi.mock("@/config/x402", () => ({
  atomicToUsdc: (v: string) => (Number(v) / 1_000_000).toString(),
}));

vi.mock("@/lib/x402/client", () => ({
  createPayment: vi.fn(async () => ({ payload: { sig: "0x" }, header: "h" })),
}));

vi.mock("@/lib/x402/server", () => ({
  createPaymentRequirements: vi.fn(() => ({ resource: "drop:7" })),
  settlePayment: vi.fn(async () => ({ success: true, txHash: "0xsettle" })),
}));

vi.mock("@/lib/onchain/glue_client", () => ({
  getDrop: vi.fn(),
  getStore: vi.fn(async () => ({ storeId: "1", owner: "0x", agentId: "0", slug: "s" })),
  grantProof: vi.fn(async () => ({ txHash: "0xproof" })),
  mintEdition: vi.fn(async () => ({ tokenId: "11", txHash: "0xmint", blockNumber: 3 })),
  isMandateValid: vi.fn(),
  canSpend: vi.fn(),
  recordSpend: vi.fn(async () => ({ txHash: "0xspend" })),
}));

vi.mock("@/lib/onchain/reputation", () => ({
  submitPurchaseFeedback: vi.fn(async () => ({ submitted: false, skipped: true, reason: "test" })),
}));

import {
  getDrop,
  isMandateValid,
  canSpend,
  recordSpend,
  mintEdition,
} from "@/lib/onchain/glue_client";
import { settlePayment } from "@/lib/x402/server";
import { purchaseEditionWithMandate } from "@/lib/x402/purchase_orchestrator";

const wallet = { address: "0xagent" } as unknown as ethers.Wallet;
const input = {
  chain: "arbitrumSepolia" as never,
  dropId: "7",
  mandateId: "4",
};

const activeDrop = {
  dropId: "7",
  creator: "0xcreator",
  storeId: "1",
  assetLeaf: "0x" + "0".repeat(64),
  price: "1500000",
  maxSupply: "0",
  minted: "0",
  active: true,
  requiresProof: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getDrop).mockResolvedValue(activeDrop);
  vi.mocked(isMandateValid).mockResolvedValue(true);
  vi.mocked(canSpend).mockResolvedValue(true);
});

describe("purchaseEditionWithMandate", () => {
  it("purchases within budget and records the spend", async () => {
    const result = await purchaseEditionWithMandate(wallet, input);
    expect(result.mandateId).toBe("4");
    expect(result.recordSpendTxHash).toBe("0xspend");
    expect(result.tokenId).toBe("11");
    expect(recordSpend).toHaveBeenCalledWith(
      wallet,
      expect.objectContaining({ mandateId: "4", amount: "1500000" }),
    );
  });

  it("rejects before settlement when the mandate is invalid", async () => {
    vi.mocked(isMandateValid).mockResolvedValue(false);
    await expect(purchaseEditionWithMandate(wallet, input)).rejects.toThrow(/invalid or expired/);
    expect(settlePayment).not.toHaveBeenCalled();
    expect(mintEdition).not.toHaveBeenCalled();
    expect(recordSpend).not.toHaveBeenCalled();
  });

  it("rejects before settlement when the spend exceeds the cap", async () => {
    vi.mocked(canSpend).mockResolvedValue(false);
    await expect(purchaseEditionWithMandate(wallet, input)).rejects.toThrow(/over remaining cap/);
    expect(settlePayment).not.toHaveBeenCalled();
    expect(recordSpend).not.toHaveBeenCalled();
  });

  it("rejects an inactive drop", async () => {
    vi.mocked(getDrop).mockResolvedValue({ ...activeDrop, active: false });
    await expect(purchaseEditionWithMandate(wallet, input)).rejects.toThrow(/not active/);
  });
});
