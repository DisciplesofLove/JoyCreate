/**
 * Lit Protocol Relayer.
 *
 * The DataLease Stylus contract emits `LeaseGranted(leaseId, listingId,
 * lessee, tokenId, paidWei, expiresAt, accConditionsHash)` on every
 * `purchaseLease()` call. The IPC handler mirrors that grant into
 * `data_lease_grants` with `relayer_status = "pending"`.
 *
 * This service polls for pending rows and, for each one:
 *   1. Resolves the Lit Protocol Access Control Conditions (ACC) blob
 *      whose `keccak256(JSON.stringify(conditions))` matches the
 *      `accConditionsHash` on-chain (inside the configured Lit Action).
 *   2. Executes the Lit Action that provisions a time-bound decryption key
 *      bound to `lessee` and valid until `expiresAt`.
 *   3. Marks the row `provisioned` (or `failed` with `relayerError`).
 *
 * Configuration: JOY_LIT_NETWORK, JOY_LIT_PKP_PUBKEY, JOY_LIT_ACTION_CID
 * (see src/config/tee.ts). When unconfigured, grants fail with a clear
 * error rather than fake-succeeding.
 */

import log from "electron-log";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { dataLeaseGrants } from "@/db/schema";
import { resolveLitConfig } from "@/config/tee";

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
 * Default provisioner: real Lit Protocol integration when configured, honest
 * failure otherwise.
 *
 * When `JOY_LIT_NETWORK`, `JOY_LIT_PKP_PUBKEY` and `JOY_LIT_ACTION_CID` are
 * set (see src/config/tee.ts), the provisioner lazily loads the Lit SDK and
 * executes the configured Lit Action, which resolves the ACC blob for
 * `accConditionsHash` and provisions a time-bound decryption key for the
 * lessee. Without configuration, grants are marked `failed` with a clear
 * error instead of fake-success — recipients must never believe a key was
 * provisioned when it wasn't. Tests can inject a fake via `setLitProvisioner`.
 */
let provisioner: LitProvisioner = async (args) => {
  const cfg = resolveLitConfig();
  if (!cfg) {
    logger.warn(
      "Lit relayer not configured — lease grant cannot be provisioned",
      args.leaseId,
    );
    return {
      ok: false,
      error:
        "Lit relayer not configured. Set JOY_LIT_NETWORK, JOY_LIT_PKP_PUBKEY and " +
        "JOY_LIT_ACTION_CID to enable decryption-key provisioning for data leases.",
    };
  }
  if (!cfg.actionCid) {
    return {
      ok: false,
      error:
        "JOY_LIT_ACTION_CID is not set. Lease provisioning requires the Lit Action " +
        "that resolves ACC conditions and provisions the time-bound key.",
    };
  }

  let LitNodeClientClass: unknown;
  try {
    const mod: unknown = await import(
      /* @vite-ignore */ "@lit-protocol/lit-node-client"
    );
    LitNodeClientClass = (mod as { LitNodeClient?: unknown }).LitNodeClient;
  } catch {
    return {
      ok: false,
      error:
        "@lit-protocol/lit-node-client is not installed. Run " +
        "`npm i @lit-protocol/lit-node-client` to enable lease provisioning.",
    };
  }
  if (typeof LitNodeClientClass !== "function") {
    return {
      ok: false,
      error: "@lit-protocol/lit-node-client did not export LitNodeClient",
    };
  }

  const Ctor = LitNodeClientClass as new (opts: { litNetwork: string }) => {
    connect(): Promise<void>;
    executeJs(callArgs: {
      ipfsId: string;
      jsParams: Record<string, unknown>;
    }): Promise<{ response?: unknown }>;
    disconnect?(): Promise<void>;
  };

  const client = new Ctor({ litNetwork: cfg.network });
  await client.connect();
  try {
    const res = await client.executeJs({
      ipfsId: cfg.actionCid,
      jsParams: {
        leaseId: args.leaseId,
        listingId: args.listingId,
        lessee: args.lessee,
        tokenId: args.tokenId,
        accConditionsHash: args.accConditionsHash,
        expiresAtUnix: args.expiresAtUnix,
        publicKey: cfg.pkpPublicKey,
      },
    });
    const receipt =
      typeof res.response === "string"
        ? res.response
        : JSON.stringify(res.response ?? "");
    return { ok: true, receipt: receipt || `lit:${args.leaseId}` };
  } finally {
    await client.disconnect?.().catch(() => undefined);
  }
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
  // Schedule the first poll after one interval. We can't fire immediately
  // because registerIpcHandlers() runs before initializeDatabase() in main.ts,
  // so the DB isn't ready when this function is invoked. The interval gives
  // the DB time to initialize during onReady().
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
