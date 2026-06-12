/**
 * LR14 — A2A runtime executor for Licensed Runtime Assets.
 *
 * Provides the `InvocationExecutor` registered under the `lra.runtime`
 * capability (LR13). When an A2A contract for that capability is invoked, this
 * executor recovers the on-chain binding from the listing, then runs the
 * agent's LRA behind the same license + Proof-of-Use gate as a direct
 * `runtime_invoke` (LR8–LR10) — metered via LR12.
 *
 * Full cross-agent flow:
 *   discover (A2A listing) → quote → escrow (rewardsLedger) → invokeContract →
 *   THIS executor runs the LRA → deliver → verify → settle to the provider.
 *
 * The runtime invoker is injected so the executor is unit-tested without the
 * model / IPFS / chain stack.
 */

import log from "electron-log";

import type { InvocationExecutor } from "@/lib/a2a_economy";
import { invokeAndMeter } from "@/lib/onchain/runtime_metering";
import { readListingBinding, type LraBinding } from "@/lib/onchain/lra_a2a_bridge";
import { recordRuntimeEarning } from "@/lib/onchain/runtime_earnings";
import type { LicenseTerms } from "@/lib/onchain/license";

const logger = log.scope("lra_a2a_executor");

export interface LraExecutorDeps {
  invoke?: typeof invokeAndMeter;
  readBinding?: typeof readListingBinding;
  /** Mirror the settled contract amount into the earnings ledger. */
  recordEarning?: typeof recordRuntimeEarning;
}

/** Extract the user-facing string input from an A2A invocation payload. */
function extractInput(input: Record<string, unknown> | null): string {
  const value = input?.input;
  if (typeof value === "string") return value;
  throw new Error("A2A invocation input must carry a string 'input' field for lra.runtime");
}

/**
 * Build the `lra.runtime` executor. The consumer passes the license proving
 * `runtimeExecution` (plus optional `dropId`/`buyer` for PoU) inside the
 * invocation input — the executor never bypasses the runtime gate.
 */
export function createLraRuntimeExecutor(deps: LraExecutorDeps = {}): InvocationExecutor {
  const invoke = deps.invoke ?? invokeAndMeter;
  const readBinding = deps.readBinding ?? readListingBinding;
  const recordEarning = deps.recordEarning ?? recordRuntimeEarning;

  return async ({ contract, listing, input }) => {
    const binding: LraBinding | null = readBinding(listing);
    if (!binding) {
      throw new Error(`listing ${listing.id} carries no LRA binding (not bridged via LR13)`);
    }

    const userInput = extractInput(input);
    const license = (input?.license ?? null) as LicenseTerms | string | null;
    const dropId = typeof input?.dropId === "string" ? input.dropId : undefined;
    const buyer = typeof input?.buyer === "string" ? input.buyer : undefined;

    const receipt = await invoke({
      chain: binding.chain,
      agentId: binding.erc8004AgentId,
      input: userInput,
      license,
      dropId,
      buyer,
    });

    logger.info(
      `lra.runtime executed agent=${binding.erc8004AgentId} (${binding.chain}) ` +
        `${receipt.durationMs}ms via listing ${listing.id}`,
    );

    // Mirror the escrowed contract amount into the earnings ledger. The A2A
    // economy holds the funds (escrow → settle to provider); we surface the
    // income in the dashboard at delivery, idempotent per contract.
    if (contract.currency === "USDC") {
      await recordEarning({
        agentRef: binding.erc8004AgentId,
        agentName: listing.name,
        amountUsdc: contract.amount,
        txHash: `a2a:contract:${contract.id}`,
      });
    }

    return {
      output: {
        output: receipt.output,
        skillCid: receipt.skillCid,
        kind: receipt.kind,
        finishReason: receipt.finishReason,
        steps: receipt.steps,
        durationMs: receipt.durationMs,
      },
      inputTokens: receipt.usage?.promptTokens,
      outputTokens: receipt.usage?.completionTokens,
      provider: "lra.runtime",
      model: receipt.modelId,
    };
  };
}
