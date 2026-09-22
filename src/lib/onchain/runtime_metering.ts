/**
 * LR12 — Runtime metering + reputation feedback.
 *
 * Wraps `invokeSkillRuntime` (LR8/LR9/LR10) with per-invocation accounting:
 *   - measures wall-clock duration and captures token usage,
 *   - emits a structured `RuntimeReceipt`,
 *   - optionally submits ERC-8004 ReputationRegistry feedback (LR3) after a
 *     successful run,
 *   - optionally triggers a per-invocation micro-charge (x402 / RevenueSplitter).
 *
 * Everything that touches the chain or the clock is injectable (`MeterDeps`) so
 * the orchestration is unit-testable without a wallet, a contract, or real time.
 * No new persistence table — the receipt is returned (and can be forwarded to an
 * injected sink), keeping the existing rewards/receipt ledgers authoritative.
 */

import log from "electron-log";
import type { ethers } from "ethers";

import { invokeSkillRuntime, type RuntimeInvokeInput, type SkillBundle } from "@/lib/onchain/skill_runtime";
import { submitFeedback } from "@/lib/onchain/erc8004_client";
import { recordRuntimeEarning } from "@/lib/onchain/runtime_earnings";
import type { Erc8004ChainId } from "@/config/erc8004";

const logger = log.scope("runtime_metering");

/** Default reputation score recorded for a successful invocation. */
export const DEFAULT_SUCCESS_SCORE = 100;

export interface RuntimeUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/** Optional auto-feedback after a successful run (reuses LR3 ReputationRegistry). */
export interface FeedbackConfig {
  /** Wallet authorized to submit feedback for `clientId`. */
  wallet: ethers.Wallet;
  chain: Erc8004ChainId;
  /** Consumer (client) agent id leaving the feedback. */
  clientId: string;
  /** Provider (server) agent id being rated. */
  serverId: string;
  /** Score in [0,100]. Defaults to `DEFAULT_SUCCESS_SCORE`. */
  score?: number;
  /** Optional IPFS/HTTP URI of a detailed feedback document. */
  feedbackUri?: string;
}

/** Optional per-invocation micro-charge (x402 / RevenueSplitter rail). */
export type ChargeFn = () => Promise<{
  txHash: string;
  /** USDC (6-dec) base-unit amount charged — when present, recorded as an earning. */
  amountUsdc?: string;
  /** Payer / renter address, for the earnings ledger. */
  renterAddress?: string;
}>;

export interface MeteredInvokeInput extends RuntimeInvokeInput {
  /** When present, submit reputation feedback after a successful run. */
  feedback?: FeedbackConfig;
}

export interface RuntimeReceipt {
  agentId: string;
  skillCid: string;
  kind: SkillBundle["kind"];
  modelId: string;
  output: string;
  finishReason: string;
  steps?: number;
  usage?: RuntimeUsage;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  /** Set when reputation feedback was submitted. */
  feedbackTxHash?: string;
  /** Set when a per-invocation micro-charge was applied. */
  chargeTxHash?: string;
}

export interface MeterDeps {
  /** Override the runtime invoker (and its own fetch/infer/tool/code deps). */
  invoke?: typeof invokeSkillRuntime;
  /** Override the reputation feedback submitter. */
  submitFeedback?: typeof submitFeedback;
  /** Optional micro-charge hook; runs only when provided. */
  charge?: ChargeFn;
  /** Mirror a successful charge into the earnings ledger. */
  recordEarning?: typeof recordRuntimeEarning;
  /** Clock injection for deterministic tests. */
  now?: () => number;
}

/**
 * Invoke a skill runtime and produce a metered receipt. Feedback and charging
 * are best-effort: a failure to submit feedback or to charge is logged and does
 * NOT discard the (already produced) runtime output.
 */
export async function invokeAndMeter(
  input: MeteredInvokeInput,
  deps: MeterDeps = {},
): Promise<RuntimeReceipt> {
  const invoke = deps.invoke ?? invokeSkillRuntime;
  const now = deps.now ?? Date.now;

  const startMs = now();
  const startedAt = new Date(startMs).toISOString();
  const result = await invoke(input);
  const finishMs = now();

  const receipt: RuntimeReceipt = {
    agentId: result.agentId,
    skillCid: result.skillCid,
    kind: result.kind,
    modelId: result.modelId,
    output: result.output,
    finishReason: result.finishReason,
    steps: result.steps,
    usage: result.usage,
    startedAt,
    finishedAt: new Date(finishMs).toISOString(),
    durationMs: finishMs - startMs,
  };

  // Optional per-invocation micro-charge (x402 / RevenueSplitter).
  if (deps.charge) {
    try {
      const charged = await deps.charge();
      receipt.chargeTxHash = charged.txHash;
      // Mirror the charge into the earnings ledger when an amount is known.
      if (charged.amountUsdc) {
        const recordEarning = deps.recordEarning ?? recordRuntimeEarning;
        await recordEarning({
          agentRef: receipt.agentId,
          agentName: `runtime:${receipt.skillCid}`,
          amountUsdc: charged.amountUsdc,
          renterAddress: charged.renterAddress,
          txHash: charged.txHash,
        });
      }
    } catch (err) {
      logger.warn(`micro-charge failed (output still returned): ${(err as Error).message}`);
    }
  }

  // Optional reputation feedback after a successful run (LR3).
  if (input.feedback) {
    const submit = deps.submitFeedback ?? submitFeedback;
    const score = input.feedback.score ?? DEFAULT_SUCCESS_SCORE;
    try {
      const { txHash } = await submit(input.feedback.wallet, {
        chain: input.feedback.chain,
        clientId: input.feedback.clientId,
        serverId: input.feedback.serverId,
        score,
        feedbackUri: input.feedback.feedbackUri,
      });
      receipt.feedbackTxHash = txHash;
    } catch (err) {
      logger.warn(`reputation feedback failed (output still returned): ${(err as Error).message}`);
    }
  }

  logger.info(
    `metered ${receipt.kind} ${receipt.skillCid} agent=${receipt.agentId} ` +
      `${receipt.durationMs}ms tokens=${receipt.usage?.totalTokens ?? "n/a"}`,
  );
  return receipt;
}
