import { describe, it, expect, vi } from "vitest";

import { recordContentEarning } from "@/lib/onchain/content_earnings";

describe("recordContentEarning", () => {
  it("namespaces the agentRef by kind and forwards to the ledger sink", async () => {
    const insert = vi.fn().mockResolvedValue(undefined);
    const hasTxHash = vi.fn().mockResolvedValue(false);
    const wrote = await recordContentEarning(
      {
        kind: "dataset",
        entityRef: "1234",
        name: "Dataset lease",
        amount: "5000",
        buyerAddress: "0xlessee",
        txHash: "0xgrant",
      },
      { insert, hasTxHash },
    );
    expect(wrote).toBe(true);
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        agentRef: "dataset:1234",
        agentName: "Dataset lease",
        amountUsdc: "5000",
        renterAddress: "0xlessee",
        txHash: "0xgrant",
      }),
    );
  });

  it("supports blueprint and library-item kinds", async () => {
    const insert = vi.fn().mockResolvedValue(undefined);
    const hasTxHash = vi.fn().mockResolvedValue(false);
    await recordContentEarning(
      { kind: "blueprint", entityRef: 9, name: "BP", amount: "10" },
      { insert, hasTxHash },
    );
    await recordContentEarning(
      { kind: "library-item", entityRef: 3, name: "Asset", amount: "20" },
      { insert, hasTxHash },
    );
    expect(insert).toHaveBeenNthCalledWith(1, expect.objectContaining({ agentRef: "blueprint:9" }));
    expect(insert).toHaveBeenNthCalledWith(2, expect.objectContaining({ agentRef: "library-item:3" }));
  });

  it("skips zero / invalid amounts", async () => {
    const insert = vi.fn();
    const hasTxHash = vi.fn();
    expect(
      await recordContentEarning(
        { kind: "dataset", entityRef: 1, name: "x", amount: "0" },
        { insert, hasTxHash },
      ),
    ).toBe(false);
    expect(insert).not.toHaveBeenCalled();
  });
});
