/**
 * App Marketplace IPC Handlers
 *
 * Publishing JoyCreate apps to JoyMarketplace via the Arbitrum "create → license
 * to our store" path: `publishAndMonetize` pins the app bundle, mints the
 * edition, creates the EditionController drop, and emits the ERC-1144 blueprint.
 *
 * Mirrors `agent_marketplace_handlers.ts`. The orchestrator NEVER throws — every
 * failure is reported via the outcome's `errors` / `publish.blockedAt` so the
 * renderer can surface actionable problems.
 */

import { ipcMain } from "electron";
import { eq } from "drizzle-orm";
import log from "electron-log";
import * as fs from "fs-extra";

import { db } from "@/db";
import { apps } from "@/db/schema";
import { guarded } from "@/ipc/utils/guarded_handle";
import type { UnifiedPublishPayload, PublishResult } from "@/types/publish_types";
import {
  publishAndMonetize,
  type PublishAndMonetizeOutcome,
} from "@/lib/joymarketplace/publish_and_monetize";
import { createAppZip } from "./marketplace_handlers";

const logger = log.scope("app_marketplace");

export interface PublishAppPayload {
  appId: number;
  /** Listing name override; defaults to the app record name. */
  name?: string;
  /** Listing description (apps table has no description column). */
  description?: string;
  /** Human USDC price (e.g. 1.5). 0 = free. */
  priceUsdc?: number;
  royaltyBps?: number;
  category?: string;
  /** SPDX-ish license string recorded in metadata. */
  license?: string;
  /** Store slug override; defaults to the configured marketplaceStoreSlug. */
  storeSlug?: string;
  /** Extra metadata merged into the listing. */
  metadata?: Record<string, unknown>;
  dryRun?: boolean;
}

/**
 * Publish a single app to JoyMarketplace via the on-chain monetize orchestrator.
 * Exported as a callable so bots / autonomous flows can invoke it directly.
 * Returns the outcome augmented with the app record id. Never throws.
 */
export async function publishAppToMarketplace(
  payload: PublishAppPayload,
): Promise<PublishAndMonetizeOutcome & { appId: number }> {
  const { appId } = payload;
  const dryRun = Boolean(payload.dryRun);
  logger.info(`Publishing app ${appId} to marketplace (dryRun=${dryRun})`);

  const appRecord = await db.query.apps.findFirst({ where: eq(apps.id, appId) });
  if (!appRecord) {
    const message = `App not found: ${appId}`;
    return {
      ok: false,
      dryRun,
      publish: { ok: false, dryRun, errors: [message] },
      chain: null,
      errors: [message],
      appId,
    };
  }

  let zipPath: string | undefined;
  try {
    zipPath = await createAppZip(appId);
    const contentBuffer = await fs.readFile(zipPath);

    const outcome = await publishAndMonetize({
      publish: {
        assetType: "app",
        name: payload.name ?? appRecord.name,
        description: payload.description,
        contentBuffer,
        contentMimeType: "application/zip",
        metadata: {
          ...payload.metadata,
          category: payload.category ?? "app",
          appAssetType: appRecord.assetType ?? undefined,
        },
        license: payload.license,
      },
      storeSlug: payload.storeSlug,
      priceUsdc: payload.priceUsdc ?? 0,
      royaltyBps: payload.royaltyBps ?? 250,
      dryRun,
    });

    if (outcome.ok) {
      logger.info(
        `App ${appId} ${outcome.dryRun ? "dry-run" : "published"} as token ` +
          `${outcome.publish.tokenId ?? "n/a"} drop ${outcome.dropId ?? "n/a"}`,
      );
    } else {
      logger.warn(
        `App ${appId} publish failed: ${outcome.errors.join("; ") || "unknown error"}`,
      );
    }

    return { ...outcome, appId };
  } finally {
    // Best-effort cleanup of the temp zip.
    if (zipPath) {
      try {
        await fs.remove(zipPath);
      } catch {
        // ignore cleanup failures
      }
    }
  }
}

// ---------------------------------------------------------------------------
// IPC registration
// ---------------------------------------------------------------------------

export function registerAppMarketplaceHandlers(): void {
  ipcMain.handle(
    "app:publish-to-marketplace",
    guarded("app:publish-to-marketplace", async (
      _e,
      payload: UnifiedPublishPayload & { dryRun?: boolean; storeSlug?: string },
    ): Promise<PublishResult & { onchain: PublishAndMonetizeOutcome }> => {
      const appId = Number(payload.sourceId);
      if (!Number.isFinite(appId) || appId <= 0) {
        throw new Error(`Invalid app id: ${String(payload.sourceId)}`);
      }

      const outcome = await publishAppToMarketplace({
        appId,
        name: payload.name,
        description: payload.description,
        // payload.price is in CENTS (legacy convention); orchestrator wants dollars.
        priceUsdc:
          typeof payload.price === "number" ? payload.price / 100 : undefined,
        royaltyBps:
          typeof (payload as { royaltyBps?: number }).royaltyBps === "number"
            ? (payload as { royaltyBps?: number }).royaltyBps
            : undefined,
        category: typeof payload.category === "string" ? payload.category : undefined,
        license: payload.license,
        storeSlug: payload.storeSlug,
        metadata: payload.metadata,
        dryRun: payload.dryRun,
      });

      const tokenId = outcome.publish.tokenId;
      return {
        assetId: tokenId ?? `pending-${Date.now()}`,
        assetUrl:
          outcome.marketplaceUrl ??
          (tokenId ? `https://joymarketplace.io/asset/${tokenId}` : ""),
        status: outcome.ok ? (outcome.dryRun ? "draft" : "published") : "draft",
        onchain: outcome,
      } as PublishResult & { onchain: PublishAndMonetizeOutcome };
    }),
  );
}
