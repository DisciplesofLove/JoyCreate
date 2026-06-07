/**
 * Workflow Marketplace IPC Handlers
 * Publishing, unpublishing, and installing workflows from JoyMarketplace
 *
 * Publishing routes through the on-chain `publishAndMonetize` orchestrator
 * (pin -> mint -> store drop on Arbitrum) instead of the Supabase
 * `/v1/assets/publish` endpoint (which doesn't exist for joy_xxx keys and
 * double-prefixed `/v1`). The orchestrator NEVER throws — every failure is
 * reported via the outcome's `errors` so the renderer can surface it.
 */

import { ipcMain, app } from "electron";
import { db } from "@/db";
import { sql } from "drizzle-orm";
import log from "electron-log";
import * as fs from "fs-extra";
import * as path from "path";
import { guarded } from "@/ipc/utils/guarded_handle";
import type { UnifiedPublishPayload, PublishResult } from "@/types/publish_types";
import { JOYMARKETPLACE_API } from "@/config/joymarketplace";
import {
  publishAndMonetize,
  type PublishAndMonetizeOutcome,
} from "@/lib/joymarketplace/publish_and_monetize";

const logger = log.scope("workflow_marketplace");

const MARKETPLACE_API_URL = JOYMARKETPLACE_API.baseUrl;

async function getCredentials(): Promise<{ apiKey: string; publisherId: string }> {
  const credPath = path.join(
    app.getPath("userData"),
    "marketplace-credentials.json"
  );
  if (!(await fs.pathExists(credPath))) {
    throw new Error(
      "Not authenticated with JoyMarketplace. Please connect your account first."
    );
  }
  const data = await fs.readJson(credPath);
  if (!data?.apiKey) throw new Error("Invalid marketplace credentials");
  return data;
}

/**
 * Read a workflow JSON from the local n8n workflows folder
 */
async function readWorkflowFile(
  workflowId: string
): Promise<Record<string, unknown>> {
  const workflowDir = path.join(app.getPath("userData"), "n8n-workflows");
  const filePath = path.join(workflowDir, `${workflowId}.json`);
  if (!(await fs.pathExists(filePath))) {
    throw new Error(`Workflow file not found: ${workflowId}`);
  }
  return fs.readJson(filePath);
}

export interface PublishWorkflowPayload {
  workflowId: string;
  name?: string;
  description?: string;
  /** Human USDC price (e.g. 1.5). 0 = free. */
  priceUsdc?: number;
  royaltyBps?: number;
  category?: string;
  license?: string;
  /** Store slug override; defaults to the configured marketplaceStoreSlug. */
  storeSlug?: string;
  metadata?: Record<string, unknown>;
  dryRun?: boolean;
}

/**
 * Publish a single workflow to JoyMarketplace via the on-chain monetize
 * orchestrator. Exported as a callable so bots / autonomous flows can invoke
 * it directly. Returns the outcome augmented with the workflow id. Never throws.
 */
export async function publishWorkflowToMarketplace(
  payload: PublishWorkflowPayload,
): Promise<PublishAndMonetizeOutcome & { workflowId: string }> {
  const workflowId = String(payload.workflowId);
  const dryRun = Boolean(payload.dryRun);
  logger.info(`Publishing workflow ${workflowId} to marketplace (dryRun=${dryRun})`);

  const workflowJson = await readWorkflowFile(workflowId);

  // Extract metadata from the workflow structure.
  const nodes = (workflowJson.nodes as Array<Record<string, unknown>>) ?? [];
  const connections =
    (workflowJson.connections as Record<string, unknown>) ?? {};
  const triggerNode = nodes.find((n) => {
    const t = typeof n.type === "string" ? n.type : "";
    return t.includes("Trigger") || t.includes("webhook") || t.includes("cron");
  });
  const triggerType =
    triggerNode && typeof triggerNode.type === "string"
      ? triggerNode.type
      : "manual";

  // Sanitize workflow: strip credential IDs/secrets, keep type references only.
  const sanitizedWorkflow = JSON.parse(
    JSON.stringify(workflowJson),
  ) as Record<string, unknown>;
  for (const node of (sanitizedWorkflow.nodes ?? []) as Array<
    Record<string, unknown>
  >) {
    const credentials = node.credentials as Record<string, unknown> | undefined;
    if (credentials) {
      for (const key of Object.keys(credentials)) {
        const cred = credentials[key];
        if (typeof cred === "object" && cred !== null) {
          credentials[key] = { name: (cred as { name?: string }).name ?? key };
        }
      }
    }
  }

  const outcome = await publishAndMonetize({
    publish: {
      assetType: "workflow",
      name: payload.name ?? workflowId,
      description: payload.description,
      contentBuffer: Buffer.from(JSON.stringify(sanitizedWorkflow), "utf8"),
      contentMimeType: "application/json",
      metadata: {
        ...payload.metadata,
        workflowId,
        nodeCount: nodes.length,
        triggerType,
        connectionCount: Object.keys(connections).length,
        requiresCredentials: nodes.some((n) => Boolean(n.credentials)),
        category: payload.category ?? "ai-workflow",
      },
      license: payload.license,
    },
    storeSlug: payload.storeSlug,
    priceUsdc: payload.priceUsdc ?? 0,
    royaltyBps: payload.royaltyBps ?? 250,
    dryRun,
  });

  // Track publish status locally (best-effort; table may predate migration).
  if (outcome.ok && !outcome.dryRun) {
    const marketplaceId =
      outcome.publish.tokenId ?? outcome.dropId ?? workflowId;
    const listingName = payload.name ?? workflowId;
    try {
      await db.run(sql`
        INSERT INTO workflow_listings (workflow_id, name, marketplace_id, publish_status, published_at)
        VALUES (${workflowId}, ${listingName}, ${marketplaceId}, 'published', unixepoch())
        ON CONFLICT(workflow_id) DO UPDATE SET
          marketplace_id = ${marketplaceId},
          publish_status = 'published',
          published_at = unixepoch(),
          name = ${listingName}
      `);
    } catch {
      // table may not exist before migration runs
      logger.warn("workflow_listings table not yet available");
    }
  }

  if (outcome.ok) {
    logger.info(
      `Workflow ${workflowId} ${outcome.dryRun ? "dry-run" : "published"} as ` +
        `token ${outcome.publish.tokenId ?? "n/a"} drop ${outcome.dropId ?? "n/a"}`,
    );
  } else {
    logger.warn(
      `Workflow ${workflowId} publish failed: ${outcome.errors.join("; ") || "unknown error"}`,
    );
  }

  return { ...outcome, workflowId };
}

export function registerWorkflowMarketplaceHandlers() {
  // Publish a workflow to JoyMarketplace (Arbitrum store drop)
  ipcMain.handle(
    "workflow:publish-to-marketplace",
    guarded("workflow:publish-to-marketplace", async (
      _e,
      payload: UnifiedPublishPayload & { dryRun?: boolean; storeSlug?: string },
    ): Promise<PublishResult & { onchain: PublishAndMonetizeOutcome }> => {
      const outcome = await publishWorkflowToMarketplace({
        workflowId: String(payload.sourceId),
        name: payload.name,
        description: payload.description,
        // payload.price is in CENTS (legacy convention); orchestrator wants dollars.
        priceUsdc:
          typeof payload.price === "number" ? payload.price / 100 : undefined,
        royaltyBps:
          typeof (payload as { royaltyBps?: number }).royaltyBps === "number"
            ? (payload as { royaltyBps?: number }).royaltyBps
            : undefined,
        category:
          typeof payload.category === "string" ? payload.category : undefined,
        license: payload.license,
        storeSlug: payload.storeSlug,
        metadata: payload.metadata,
        dryRun: payload.dryRun,
      });

      const tokenId = outcome.publish.tokenId;
      return {
        assetId: tokenId ?? outcome.dropId ?? `pending-${Date.now()}`,
        assetUrl:
          outcome.marketplaceUrl ??
          (tokenId ? `https://joymarketplace.io/asset/${tokenId}` : ""),
        status: outcome.ok ? (outcome.dryRun ? "draft" : "published") : "draft",
        onchain: outcome,
      } as PublishResult & { onchain: PublishAndMonetizeOutcome };
    }),
  );

  // Install a workflow from marketplace
  ipcMain.handle(
    "workflow:install-from-marketplace",
    async (_, assetId: string): Promise<{ workflowId: string }> => {
      logger.info(`Installing workflow from marketplace: ${assetId}`);

      const { apiKey } = await getCredentials();
      const response = await fetch(
        `${MARKETPLACE_API_URL}/v1/assets/${encodeURIComponent(assetId)}/download`,
        {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            Accept: "application/json",
          },
        }
      );

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Download failed: ${response.status} — ${body}`);
      }

      const workflowJson = await response.json();

      // Persist to local n8n workflows folder
      const workflowDir = path.join(app.getPath("userData"), "n8n-workflows");
      await fs.ensureDir(workflowDir);

      const workflowId =
        workflowJson.id ?? `marketplace-${assetId}-${Date.now()}`;
      const destPath = path.join(workflowDir, `${workflowId}.json`);
      await fs.writeJson(destPath, workflowJson, { spaces: 2 });

      logger.info(`Workflow installed as ${workflowId} at ${destPath}`);

      return { workflowId };
    }
  );

  // Unpublish a workflow
  ipcMain.handle("workflow:unpublish", async (_, workflowId: string) => {
    logger.info(`Unpublishing workflow ${workflowId}`);

    let marketplaceId: string | undefined;
    try {
      const row = await db.get<{ marketplace_id: string }>(
        sql`SELECT marketplace_id FROM workflow_listings WHERE workflow_id = ${workflowId}`
      );
      marketplaceId = row?.marketplace_id;
    } catch {
      throw new Error("Workflow has no marketplace listing");
    }

    if (!marketplaceId) {
      throw new Error("Workflow has no marketplace listing");
    }

    const { apiKey, publisherId } = await getCredentials();
    await fetch(
      `${MARKETPLACE_API_URL}/v1/assets/${encodeURIComponent(marketplaceId)}/archive`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "X-Publisher-ID": publisherId,
        },
      }
    );

    try {
      await db.run(sql`
        UPDATE workflow_listings SET publish_status = 'archived' WHERE workflow_id = ${workflowId}
      `);
    } catch {
      // not critical
    }

    logger.info(`Workflow ${workflowId} unpublished`);
  });

  // List workflow publish statuses
  ipcMain.handle("workflow:list-published", async () => {
    try {
      return await db.all(sql`SELECT * FROM workflow_listings`);
    } catch {
      return [];
    }
  });
}
