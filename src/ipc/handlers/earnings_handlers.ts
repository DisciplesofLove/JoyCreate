/**
 * Earnings IPC handlers — Phase 1B.
 *
 * Reads from the new `agent_rental_earnings` and `subscription_earnings`
 * ledgers (DEAI Phase 0A schema). The ledgers are populated by other
 * subsystems (rental engine, subscription billing) over time; until then
 * these queries simply return empty arrays.
 *
 * Channels:
 *   earnings:list-agent-rentals   → AgentRentalEarningRow[]
 *   earnings:list-subscriptions   → SubscriptionEarningRow[]
 *   earnings:summary              → { agentTotalUsdc, subscriptionTotalUsdc }
 */

import { ipcMain } from "electron";
import log from "electron-log";
import { desc } from "drizzle-orm";

import { db } from "@/db";
import { agentRentalEarnings, subscriptionEarnings } from "@/db/schema";

const logger = log.scope("earnings_handlers");

const DEFAULT_LIMIT = 200;

function clampLimit(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(1000, Math.floor(raw)));
}

function sumUsdc(rows: Array<{ amountUsdc: string }>): string {
  // amountUsdc is a string of base-units (USDC has 6 decimals). Sum as BigInt
  // to avoid floating point drift, return as decimal string.
  let total = 0n;
  for (const r of rows) {
    try {
      total += BigInt(r.amountUsdc);
    } catch {
      // skip malformed rows
    }
  }
  return total.toString();
}

export function registerEarningsHandlers(): void {
  ipcMain.handle("earnings:list-agent-rentals", async (_e, args?: { limit?: number }) => {
    const limit = clampLimit(args?.limit);
    return db
      .select()
      .from(agentRentalEarnings)
      .orderBy(desc(agentRentalEarnings.earnedAt))
      .limit(limit);
  });

  ipcMain.handle("earnings:list-subscriptions", async (_e, args?: { limit?: number }) => {
    const limit = clampLimit(args?.limit);
    return db
      .select()
      .from(subscriptionEarnings)
      .orderBy(desc(subscriptionEarnings.earnedAt))
      .limit(limit);
  });

  ipcMain.handle("earnings:summary", async () => {
    const [agents, subs] = await Promise.all([
      db.select({ amountUsdc: agentRentalEarnings.amountUsdc }).from(agentRentalEarnings),
      db.select({ amountUsdc: subscriptionEarnings.amountUsdc }).from(subscriptionEarnings),
    ]);
    return {
      agentTotalUsdc: sumUsdc(agents),
      subscriptionTotalUsdc: sumUsdc(subs),
      agentCount: agents.length,
      subscriptionCount: subs.length,
    };
  });

  logger.info("earnings handlers registered");
}
