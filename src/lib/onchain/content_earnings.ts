/**
 * LRA glue — route *content* sales (datasets, blueprints, library items) into
 * the same `agent_rental_earnings` ledger the Earnings dashboard reads, so a
 * creator sees income from every monetised entity in one place.
 *
 * Runtime entities (skills / agents / apps) earn via `runtime_earnings.ts`
 * (metering + A2A settle). Content entities earn when they are purchased or
 * leased; this thin adapter normalises those events onto the shared sink.
 *
 * The ledger keys earnings by `agentRef`; content rows are namespaced
 * `"<kind>:<entityRef>"` so they never collide with on-chain agentIds.
 */

import {
  recordRuntimeEarning,
  type RuntimeEarningDeps,
} from "@/lib/onchain/runtime_earnings";

/** Non-runtime, licensable local entity kinds. */
export type ContentEntityKind = "dataset" | "blueprint" | "library-item";

export interface ContentEarningInput {
  kind: ContentEntityKind;
  /** Local row id or on-chain ref of the content entity. */
  entityRef: string | number;
  /** Display name for the dashboard. */
  name: string;
  /**
   * Paid amount as a base-unit string. Datasets settle in token wei (data-lease
   * `paidWei`); blueprint / library-item sales settle in USDC 6-dec. Stored
   * verbatim — zero / invalid amounts are skipped by the sink.
   */
  amount: string;
  /** Buyer / lessee address. */
  buyerAddress?: string;
  /** On-chain tx hash (idempotency key). */
  txHash?: string;
  blockNumber?: number;
  earnedAt?: Date;
}

/**
 * Record income from a content-entity sale. Returns true when a ledger row was
 * written, false when skipped (zero/invalid amount or duplicate txHash). Never
 * throws — accounting must not break the sale flow that triggered it.
 */
export async function recordContentEarning(
  input: ContentEarningInput,
  deps: RuntimeEarningDeps = {},
): Promise<boolean> {
  return recordRuntimeEarning(
    {
      agentRef: `${input.kind}:${input.entityRef}`,
      agentName: input.name,
      amountUsdc: input.amount,
      renterAddress: input.buyerAddress,
      txHash: input.txHash,
      blockNumber: input.blockNumber,
      earnedAt: input.earnedAt,
    },
    deps,
  );
}
