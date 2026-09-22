import { describe, it, expect, vi } from "vitest";

import { recordRuntimeEarning } from "@/lib/onchain/runtime_earnings";

describe("recordRuntimeEarning", () => {
  it("inserts a ledger row for a positive amount", async () => {
    const insert = vi.fn().mockResolvedValue(undefined);
    const hasTxHash = vi.fn().mockResolvedValue(false);
    const wrote = await recordRuntimeEarning(
      { agentRef: "42", agentName: "Skill", amountUsdc: "1000", txHash: "0xabc" },
      { insert, hasTxHash },
    );
    expect(wrote).toBe(true);
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({ agentRef: "42", agentName: "Skill", amountUsdc: "1000", txHash: "0xabc" }),
    );
  });

  it("skips zero / invalid amounts without touching the db", async () => {
    const insert = vi.fn();
    const hasTxHash = vi.fn();
    expect(await recordRuntimeEarning({ agentRef: "1", agentName: "x", amountUsdc: "0" }, { insert, hasTxHash })).toBe(false);
    expect(await recordRuntimeEarning({ agentRef: "1", agentName: "x", amountUsdc: "nope" }, { insert, hasTxHash })).toBe(false);
    expect(insert).not.toHaveBeenCalled();
    expect(hasTxHash).not.toHaveBeenCalled();
  });

  it("is idempotent — skips when the txHash was already recorded", async () => {
    const insert = vi.fn();
    const hasTxHash = vi.fn().mockResolvedValue(true);
    const wrote = await recordRuntimeEarning(
      { agentRef: "1", agentName: "x", amountUsdc: "500", txHash: "a2a:contract:9" },
      { insert, hasTxHash },
    );
    expect(wrote).toBe(false);
    expect(hasTxHash).toHaveBeenCalledWith("a2a:contract:9");
    expect(insert).not.toHaveBeenCalled();
  });

  it("never throws when the insert fails", async () => {
    const insert = vi.fn().mockRejectedValue(new Error("db down"));
    const hasTxHash = vi.fn().mockResolvedValue(false);
    const wrote = await recordRuntimeEarning(
      { agentRef: "1", agentName: "x", amountUsdc: "500" },
      { insert, hasTxHash },
    );
    expect(wrote).toBe(false);
  });
});
