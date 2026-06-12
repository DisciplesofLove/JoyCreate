import { describe, it, expect, vi } from "vitest";

import { createX402RuntimeCharge } from "@/lib/onchain/runtime_charge";
import type { settlePayment } from "@/lib/x402/server";
import type { PaymentPayload, PaymentRequirements } from "@/lib/x402/types";

const fakeInput = {
  facilitator: {} as never,
  payment: {} as PaymentPayload,
  requirements: {} as PaymentRequirements,
  creator: "0xcreator",
};

describe("createX402RuntimeCharge", () => {
  it("settles and maps the distribute hash + amount + payer", async () => {
    const settle = vi.fn<typeof settlePayment>().mockResolvedValue({
      success: true,
      txHash: "0xtransfer",
      distributeTxHash: "0xdistribute",
      payer: "0xrenter",
      amount: "2500",
    });
    const charge = createX402RuntimeCharge(fakeInput, { settle });
    const result = await charge();
    expect(result).toEqual({
      txHash: "0xdistribute",
      amountUsdc: "2500",
      renterAddress: "0xrenter",
    });
    expect(settle).toHaveBeenCalledWith(
      expect.objectContaining({ creator: "0xcreator" }),
    );
  });

  it("falls back to the transfer hash when distribute was deferred", async () => {
    const settle = vi.fn<typeof settlePayment>().mockResolvedValue({
      success: true,
      txHash: "0xtransfer",
      payer: "0xrenter",
      amount: "100",
    });
    const result = await createX402RuntimeCharge(fakeInput, { settle })();
    expect(result.txHash).toBe("0xtransfer");
  });

  it("throws when settlement is rejected", async () => {
    const settle = vi.fn<typeof settlePayment>().mockResolvedValue({
      success: false,
      error: "insufficient balance",
    });
    await expect(createX402RuntimeCharge(fakeInput, { settle })()).rejects.toThrow(
      /insufficient balance/,
    );
  });
});
