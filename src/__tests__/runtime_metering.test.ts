import { describe, it, expect, vi, beforeEach } from "vitest";

const { invokeSkillRuntimeMock, submitFeedbackMock } = vi.hoisted(() => ({
  invokeSkillRuntimeMock: vi.fn(),
  submitFeedbackMock: vi.fn(),
}));

vi.mock("@/lib/onchain/skill_runtime", () => ({
  invokeSkillRuntime: invokeSkillRuntimeMock,
}));

vi.mock("@/lib/onchain/erc8004_client", () => ({
  submitFeedback: submitFeedbackMock,
}));

import { invokeAndMeter, DEFAULT_SUCCESS_SCORE } from "@/lib/onchain/runtime_metering";
import type { ethers } from "ethers";

const RUNTIME_RESULT = {
  output: "ok",
  modelId: "llama3",
  finishReason: "stop",
  kind: "prompt-agent" as const,
  steps: 1,
  usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
  agentId: "5",
  skillCid: "QmSkill",
};

const fakeWallet = { address: "0xclient" } as unknown as ethers.Wallet;

function clock(values: number[]): () => number {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)];
}

describe("invokeAndMeter", () => {
  beforeEach(() => {
    invokeSkillRuntimeMock.mockReset();
    submitFeedbackMock.mockReset();
  });

  it("meters duration and usage into a receipt", async () => {
    invokeSkillRuntimeMock.mockResolvedValue(RUNTIME_RESULT);
    const receipt = await invokeAndMeter(
      { chain: "arbitrumSepolia", agentId: "5", input: "hi" },
      { now: clock([1_000, 1_250]) },
    );
    expect(receipt.durationMs).toBe(250);
    expect(receipt.usage?.totalTokens).toBe(15);
    expect(receipt.kind).toBe("prompt-agent");
    expect(receipt.skillCid).toBe("QmSkill");
    expect(receipt.startedAt).toBe(new Date(1_000).toISOString());
    expect(receipt.finishedAt).toBe(new Date(1_250).toISOString());
    expect(receipt.feedbackTxHash).toBeUndefined();
  });

  it("submits reputation feedback after a successful run when configured", async () => {
    invokeSkillRuntimeMock.mockResolvedValue(RUNTIME_RESULT);
    submitFeedbackMock.mockResolvedValue({ txHash: "0xfeedback" });
    const receipt = await invokeAndMeter({
      chain: "arbitrumSepolia",
      agentId: "5",
      input: "hi",
      feedback: { wallet: fakeWallet, chain: "arbitrumSepolia", clientId: "9", serverId: "5" },
    });
    expect(receipt.feedbackTxHash).toBe("0xfeedback");
    expect(submitFeedbackMock).toHaveBeenCalledWith(
      fakeWallet,
      expect.objectContaining({ clientId: "9", serverId: "5", score: DEFAULT_SUCCESS_SCORE }),
    );
  });

  it("keeps the output when feedback submission fails", async () => {
    invokeSkillRuntimeMock.mockResolvedValue(RUNTIME_RESULT);
    submitFeedbackMock.mockRejectedValue(new Error("not authorized"));
    const receipt = await invokeAndMeter({
      chain: "arbitrumSepolia",
      agentId: "5",
      input: "hi",
      feedback: { wallet: fakeWallet, chain: "arbitrumSepolia", clientId: "9", serverId: "5", score: 80 },
    });
    expect(receipt.output).toBe("ok");
    expect(receipt.feedbackTxHash).toBeUndefined();
  });

  it("applies an optional micro-charge", async () => {
    invokeSkillRuntimeMock.mockResolvedValue(RUNTIME_RESULT);
    const charge = vi.fn().mockResolvedValue({ txHash: "0xcharge" });
    const receipt = await invokeAndMeter(
      { chain: "arbitrumSepolia", agentId: "5", input: "hi" },
      { charge },
    );
    expect(charge).toHaveBeenCalledOnce();
    expect(receipt.chargeTxHash).toBe("0xcharge");
  });

  it("records an earning when the micro-charge reports an amount", async () => {
    invokeSkillRuntimeMock.mockResolvedValue(RUNTIME_RESULT);
    const charge = vi.fn().mockResolvedValue({ txHash: "0xcharge", amountUsdc: "1500", renterAddress: "0xr" });
    const recordEarning = vi.fn().mockResolvedValue(true);
    const receipt = await invokeAndMeter(
      { chain: "arbitrumSepolia", agentId: "5", input: "hi" },
      { charge, recordEarning: recordEarning as never },
    );
    expect(receipt.chargeTxHash).toBe("0xcharge");
    expect(recordEarning).toHaveBeenCalledWith(
      expect.objectContaining({
        agentRef: "5",
        amountUsdc: "1500",
        renterAddress: "0xr",
        txHash: "0xcharge",
      }),
    );
  });

  it("does not record an earning when the charge reports no amount", async () => {
    invokeSkillRuntimeMock.mockResolvedValue(RUNTIME_RESULT);
    const charge = vi.fn().mockResolvedValue({ txHash: "0xcharge" });
    const recordEarning = vi.fn();
    await invokeAndMeter(
      { chain: "arbitrumSepolia", agentId: "5", input: "hi" },
      { charge, recordEarning: recordEarning as never },
    );
    expect(recordEarning).not.toHaveBeenCalled();
  });

  it("does not submit feedback when none is configured", async () => {
    invokeSkillRuntimeMock.mockResolvedValue(RUNTIME_RESULT);
    await invokeAndMeter({ chain: "arbitrumSepolia", agentId: "5", input: "hi" });
    expect(submitFeedbackMock).not.toHaveBeenCalled();
  });
});
