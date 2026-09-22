/**
 * LRA earnings routing — mirror runtime / A2A income into the
 * `agent_rental_earnings` ledger that the Earnings dashboard reads.
 *
 * Two producers feed this sink:
 *   - LR12 metering (`invokeAndMeter`): a per-invocation micro-charge result.
 *   - LR14 A2A executor: the escrowed contract amount for a cross-agent invoke.
 *
 * Recording is idempotent by `txHash` (or a synthetic per-contract ref) so a
 * retried invocation never double-credits. DB access is injectable so the
 * orchestration is unit-testable without Electron or a real database.
 */

import log from "electron-log";
import { eq } from "drizzle-orm";

import { db } from "@/db";
import { agentRentalEarnings } from "@/db/schema";

const logger = log.scope("runtime_earnings");

export interface RuntimeEarningInput {
  /** Stable agent identifier (on-chain agentId or db row id rendered as string). */
  agentRef: string;
  agentName: string;
  /** USDC (6-dec) amount as a base-unit string. Zero / invalid amounts are skipped. */
  amountUsdc: string;
  /** Optional renter / caller address. */
  renterAddress?: string;
  /** On-chain tx hash or a synthetic ref (e.g. `a2a:contract:<id>`) for idempotency. */
  txHash?: string;
  blockNumber?: number;
  earnedAt?: Date;
}

export interface RuntimeEarningDeps {
  /** Insert a ledger row. Defaults to the real `agent_rental_earnings` table. */
  insert?: (row: typeof agentRentalEarnings.$inferInsert) => Promise<void>;
  /** Return true when an earning with this txHash already exists. */
  hasTxHash?: (txHash: string) => Promise<boolean>;
}

/** Positive base-unit amount? (rejects empty, non-numeric, zero, negative). */
function isPositiveAmount(amount: string): boolean {
  try {
    return BigInt(amount) > 0n;
  } catch {
    return false;
  }
}

async function defaultInsert(row: typeof agentRentalEarnings.$inferInsert): Promise<void> {
  await db.insert(agentRentalEarnings).values(row);
}

async function defaultHasTxHash(txHash: string): Promise<boolean> {
  const [row] = await db
    .select({ id: agentRentalEarnings.id })
    .from(agentRentalEarnings)
    .where(eq(agentRentalEarnings.txHash, txHash))
    .limit(1);
  return row != null;
}

/**
 * Record a runtime earning. Returns true when a row was written, false when it
 * was skipped (zero/invalid amount or a duplicate txHash). Never throws on a
 * persistence failure — earnings accounting must not discard runtime output.
 */
export async function recordRuntimeEarning(
  input: RuntimeEarningInput,
  deps: RuntimeEarningDeps = {},
): Promise<boolean> {
  if (!isPositiveAmount(input.amountUsdc)) {
    return false;
  }

  const insert = deps.insert ?? defaultInsert;
  const hasTxHash = deps.hasTxHash ?? defaultHasTxHash;

  try {
    if (input.txHash) {
      const exists = await hasTxHash(input.txHash);
      if (exists) {
        logger.info(`earning for tx ${input.txHash} already recorded — skipping`);
        return false;
      }
    }
    await insert({
      agentRef: input.agentRef,
      agentName: input.agentName,
      renterAddress: input.renterAddress ?? null,
      amountUsdc: input.amountUsdc,
      txHash: input.txHash ?? null,
      blockNumber: input.blockNumber ?? null,
      earnedAt: input.earnedAt ?? new Date(),
    });
    logger.info(`recorded earning agent=${input.agentRef} amount=${input.amountUsdc} (${input.txHash ?? "no-tx"})`);
    return true;
  } catch (err) {
    logger.warn(`failed to record runtime earning (output unaffected): ${(err as Error).message}`);
    return false;
  }
}
