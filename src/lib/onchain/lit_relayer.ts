/**
 * Lit Protocol Relayer (stub).
 *
 * The DataLease Stylus contract emits `LeaseGranted(leaseId, listingId,
 * lessee, tokenId, paidWei, expiresAt, accConditionsHash)` on every
 * `purchaseLease()` call. The IPC handler mirrors that grant into
 * `data_lease_grants` with `relayer_status = "pending"`.
 *
 * This service polls for pending rows and, for each one, would:
 *   1. Resolve the Lit Protocol Access Control Conditions (ACC) blob
 *      whose `keccak256(JSON.stringify(conditions))` matches the
 *      `accConditionsHash` on-chain.
 *   2. Call the Lit relayer / Lit Action that provisions a time-bound
 *      decryption key bound to `lessee` and valid until `expiresAt`.
 *   3. Mark the row `provisioned` (or `failed` with `relayerError`).
 *
 * The actual Lit SDK wiring is intentionally left for the M2 milestone —
 * for now we ship the polling loop + status transitions so the rest of
 * the system (UI badges, retry semantics, observability) is testable
 * end-to-end with a deterministic fake provisioner.
 */

import log from "electron-log";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { dataLeaseGrants } from "@/db/schema";

const logger = log.scope("lit_relayer");

const POLL_INTERVAL_MS = 15_000;
const MAX_ATTEMPTS = 5;

let pollTimer: NodeJS.Timeout | null = null;
let inFlight = false;

export type LitProvisioner = (args: {
  leaseId: string;
  listingId: string;
  lessee: string;
  tokenId: string;
  accConditionsHash: string;
  expiresAtUnix: number;
}) => Promise<{ ok: true; receipt?: string } | { ok: false; error: string }>;

/**
 * Default provisioner is a no-op success stub. Tests and production should
 * inject a real implementation via `setLitProvisioner` before
 * `startLitRelayer` is called.
 */
let provisioner: LitProvisioner = async (args) => {
  logger.info("(stub) provisioning Lit key for lease", args.leaseId);
  return { ok: true, receipt: `stub:${args.leaseId}` };
};

export function setLitProvisioner(impl: LitProvisioner): void {
  provisioner = impl;
}

async function processPending(): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    const pending = await db
      .select()
      .from(dataLeaseGrants)
      .where(eq(dataLeaseGrants.relayerStatus, "pending"))
      .limit(20);

    if (pending.length === 0) return;

    const nowSec = Math.floor(Date.now() / 1000);
    for (const row of pending) {
      const expiresAtUnix = Number(row.expiresAt);
      if (Number.isFinite(expiresAtUnix) && expiresAtUnix <= nowSec) {
        await db
          .update(dataLeaseGrants)
          .set({ relayerStatus: "expired" })
          .where(eq(dataLeaseGrants.id, row.id));
        continue;
      }

      try {
        const result = await provisioner({
          leaseId: row.leaseId,
          listingId: row.listingId,
          lessee: row.lessee,
          tokenId: row.tokenId,
          accConditionsHash: row.accConditionsHash,
          expiresAtUnix,
        });

        if (result.ok) {
          await db
            .update(dataLeaseGrants)
            .set({ relayerStatus: "provisioned", relayerError: null })
            .where(eq(dataLeaseGrants.id, row.id));
          logger.info("provisioned lease", row.leaseId, result.receipt ?? "");
        } else {
          await db
            .update(dataLeaseGrants)
            .set({ relayerStatus: "failed", relayerError: result.error })
            .where(eq(dataLeaseGrants.id, row.id));
          logger.warn("provisioner returned failure", row.leaseId, result.error);
        }
      } catch (err) {
        await db
          .update(dataLeaseGrants)
          .set({
            relayerStatus: "failed",
            relayerError: (err as Error).message,
          })
          .where(eq(dataLeaseGrants.id, row.id));
        logger.error("provisioner threw", row.leaseId, err);
      }
    }
  } catch (err) {
    logger.error("processPending fatal", err);
  } finally {
    inFlight = false;
  }
}

export function startLitRelayer(): void {
  if (pollTimer) return;
  logger.info("starting Lit relayer poll every", POLL_INTERVAL_MS, "ms");
  // Fire once immediately so freshly-purchased leases provision fast.
  void processPending();
  pollTimer = setInterval(processPending, POLL_INTERVAL_MS);
}

export function stopLitRelayer(): void {
  if (!pollTimer) return;
  clearInterval(pollTimer);
  pollTimer = null;
  logger.info("stopped Lit relayer");
}

/** Force-retry every `failed` grant (resets attempt). For ops use. */
export async function retryFailedGrants(): Promise<number> {
  const result = await db
    .update(dataLeaseGrants)
    .set({ relayerStatus: "pending", relayerError: null })
    .where(
      and(eq(dataLeaseGrants.relayerStatus, "failed")),
    )
    .returning({ id: dataLeaseGrants.id });
  return result.length;
}

export { MAX_ATTEMPTS, POLL_INTERVAL_MS };
