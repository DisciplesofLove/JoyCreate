/**
 * registration_fee — LR6 / G4 store-registration fee unit tests.
 *
 * Mocks the x402 client/server + config so no RPC/chain is touched, then
 * asserts the charge / skip / throw branches.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { ethers } from "ethers";

vi.mock("electron-log", () => ({
  default: {
    scope: () => ({ info: () => undefined, warn: () => undefined, error: () => undefined }),
  },
}));

vi.mock("@/config/x402", () => ({
  STORE_REGISTRATION_FEE_ATOMIC: "1000000",
  atomicToUsdc: (v: string) => v,
  getRegistrationFeeRecipient: vi.fn(() => "0xTreasury"),
  isRegistrationFeeReady: vi.fn(() => true),
}));

vi.mock("@/lib/x402/client", () => ({
  createPayment: vi.fn(),
}));

vi.mock("@/lib/x402/server", () => ({
  createPaymentRequirements: vi.fn(() => ({ asset: "0xUSDC" })),
  settlePayment: vi.fn(),
}));

import { getRegistrationFeeRecipient, isRegistrationFeeReady } from "@/config/x402";
import { createPayment } from "@/lib/x402/client";
import { createPaymentRequirements, settlePayment } from "@/lib/x402/server";
import { settleRegistrationFee } from "@/lib/x402/registration_fee";

const wallet = { address: "0xWallet" } as unknown as ethers.Wallet;

beforeEach(() => {
  vi.clearAllMocks();
  (isRegistrationFeeReady as ReturnType<typeof vi.fn>).mockReturnValue(true);
  (getRegistrationFeeRecipient as ReturnType<typeof vi.fn>).mockReturnValue("0xTreasury");
  (createPayment as ReturnType<typeof vi.fn>).mockResolvedValue({ payload: {}, header: "h" });
});

describe("settleRegistrationFee", () => {
  it("charges and settles the fee on a fee-ready chain", async () => {
    (settlePayment as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      txHash: "0xabc",
    });

    const res = await settleRegistrationFee(wallet, {
      chain: "arbitrumSepolia" as never,
      slug: "my-store",
    });

    expect(res.charged).toBe(true);
    expect(res.amountAtomic).toBe("1000000");
    expect(res.recipient).toBe("0xTreasury");
    expect(createPaymentRequirements).toHaveBeenCalled();
    expect(settlePayment).toHaveBeenCalledWith(
      expect.objectContaining({ creator: "0xTreasury", facilitator: wallet }),
    );
  });

  it("skips (does not throw) when the chain has no fee configured", async () => {
    (isRegistrationFeeReady as ReturnType<typeof vi.fn>).mockReturnValue(false);

    const res = await settleRegistrationFee(wallet, {
      chain: "arbitrumOne" as never,
      slug: "my-store",
    });

    expect(res.charged).toBe(false);
    expect(res.amountAtomic).toBe("0");
    expect(res.reason).toContain("not configured");
    expect(settlePayment).not.toHaveBeenCalled();
  });

  it("skips when an explicit fee amount is zero", async () => {
    const res = await settleRegistrationFee(wallet, {
      chain: "arbitrumSepolia" as never,
      slug: "my-store",
      amountAtomic: "0",
    });

    expect(res.charged).toBe(false);
    expect(res.reason).toContain("zero");
    expect(settlePayment).not.toHaveBeenCalled();
  });

  it("throws when settlement fails (so a paid chain never registers free)", async () => {
    (settlePayment as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: false,
      error: "insufficient balance",
    });

    await expect(
      settleRegistrationFee(wallet, {
        chain: "arbitrumSepolia" as never,
        slug: "my-store",
      }),
    ).rejects.toThrow("insufficient balance");
  });
});
