import { describe, it, expect, vi } from "vitest";

import { createLraRuntimeExecutor } from "@/lib/onchain/lra_a2a_executor";
import { LRA_BINDING_KEY } from "@/lib/onchain/lra_a2a_bridge";
import type { AgentServiceListingRow, A2AContractRow } from "@/db/a2a_schema";

const BOUND_LISTING = {
  id: "listing-1",
  capability: "lra.runtime",
  inputSchemaJson: {
    [LRA_BINDING_KEY]: {
      erc8004AgentId: "42",
      chain: "arbitrumSepolia",
      agentAddress: "0xc",
      skillCid: "QmSkill",
    },
  },
} as unknown as AgentServiceListingRow;

const CONTRACT = { id: "contract-1" } as unknown as A2AContractRow;

const RECEIPT = {
  agentId: "42",
  skillCid: "QmSkill",
  kind: "prompt-agent" as const,
  modelId: "llama3",
  output: "hello",
  finishReason: "stop",
  steps: 1,
  usage: { promptTokens: 10, completionTokens: 4, totalTokens: 14 },
  startedAt: "t0",
  finishedAt: "t1",
  durationMs: 120,
};

describe("createLraRuntimeExecutor", () => {
  it("recovers the binding and invokes the runtime behind the license gate", async () => {
    const invoke = vi.fn().mockResolvedValue(RECEIPT);
    const executor = createLraRuntimeExecutor({ invoke: invoke as never });

    const result = await executor({
      contract: CONTRACT,
      listing: BOUND_LISTING,
      input: { input: "say hi", license: { runtimeExecution: true }, dropId: "7", buyer: "0xb" },
    });

    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        chain: "arbitrumSepolia",
        agentId: "42",
        input: "say hi",
        license: { runtimeExecution: true },
        dropId: "7",
        buyer: "0xb",
      }),
    );
    expect(result.output.output).toBe("hello");
    expect(result.output.skillCid).toBe("QmSkill");
    expect(result.inputTokens).toBe(10);
    expect(result.outputTokens).toBe(4);
    expect(result.provider).toBe("lra.runtime");
    expect(result.model).toBe("llama3");
  });

  it("throws when the listing carries no LRA binding", async () => {
    const invoke = vi.fn();
    const executor = createLraRuntimeExecutor({ invoke: invoke as never });
    await expect(
      executor({
        contract: CONTRACT,
        listing: { id: "x", inputSchemaJson: null } as unknown as AgentServiceListingRow,
        input: { input: "hi" },
      }),
    ).rejects.toThrow(/no LRA binding/);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("throws when the invocation input has no string 'input' field", async () => {
    const invoke = vi.fn();
    const executor = createLraRuntimeExecutor({ invoke: invoke as never });
    await expect(
      executor({ contract: CONTRACT, listing: BOUND_LISTING, input: { foo: 1 } }),
    ).rejects.toThrow(/string 'input'/);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("passes a null license through when none is supplied", async () => {
    const invoke = vi.fn().mockResolvedValue(RECEIPT);
    const executor = createLraRuntimeExecutor({ invoke: invoke as never });
    await executor({ contract: CONTRACT, listing: BOUND_LISTING, input: { input: "hi" } });
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ license: null }));
  });

  it("records the escrowed contract amount as an earning for USDC contracts", async () => {
    const invoke = vi.fn().mockResolvedValue(RECEIPT);
    const recordEarning = vi.fn().mockResolvedValue(true);
    const usdcContract = {
      id: "contract-7",
      currency: "USDC",
      amount: "2500",
    } as unknown as A2AContractRow;
    const executor = createLraRuntimeExecutor({
      invoke: invoke as never,
      recordEarning: recordEarning as never,
    });
    await executor({ contract: usdcContract, listing: BOUND_LISTING, input: { input: "hi" } });
    expect(recordEarning).toHaveBeenCalledWith(
      expect.objectContaining({
        agentRef: "42",
        amountUsdc: "2500",
        txHash: "a2a:contract:contract-7",
      }),
    );
  });

  it("does not record an earning for non-USDC contracts", async () => {
    const invoke = vi.fn().mockResolvedValue(RECEIPT);
    const recordEarning = vi.fn();
    const joyContract = {
      id: "contract-8",
      currency: "JOY",
      amount: "2500",
    } as unknown as A2AContractRow;
    const executor = createLraRuntimeExecutor({
      invoke: invoke as never,
      recordEarning: recordEarning as never,
    });
    await executor({ contract: joyContract, listing: BOUND_LISTING, input: { input: "hi" } });
    expect(recordEarning).not.toHaveBeenCalled();
  });
});
