/**
 * Blueprint Marketplace IPC Handlers
 *
 * Publishes a Sovereign Blueprint (YAML DAG) to JoyMarketplace via the same
 * on-chain `PublishOrchestrator` agents and workflows use (pin → lazyMint
 * → claim conditions → Goldsky watch). Blueprints have no persisted DB
 * row of their own — the YAML text travels in
 * `payload.metadata.yamlText` straight from the BlueprintsPage editor
 * into the orchestrator content buffer.
 *
 * Renderer surface:
 *   blueprint:publish-to-marketplace → PublishResult (with .onchain outcome)
 */

import { ipcMain } from "electron";
import log from "electron-log";
import { guarded } from "@/ipc/utils/guarded_handle";
import type {
  UnifiedPublishPayload,
  PublishResult,
} from "@/types/publish_types";
import {
  publishAndForget,
  type PublishOutcome,
} from "@/lib/joymarketplace/publish_orchestrator";

const logger = log.scope("blueprint_marketplace");

export function registerBlueprintMarketplaceHandlers(): void {
  ipcMain.handle(
    "blueprint:publish-to-marketplace",
    guarded(
      "blueprint:publish-to-marketplace",
      async (
        _e,
        payload: UnifiedPublishPayload & { dryRun?: boolean },
      ): Promise<PublishResult & { onchain: PublishOutcome }> => {
        const yamlText =
          (payload.metadata?.yamlText as string | undefined) ?? "";
        if (!yamlText || typeof yamlText !== "string") {
          throw new Error(
            "blueprint:publish-to-marketplace requires metadata.yamlText (the blueprint YAML)",
          );
        }
        const blueprintId =
          (payload.metadata?.blueprintId as string | undefined) ??
          String(payload.sourceId ?? `bp-${Date.now()}`);

        logger.info(
          `Publishing blueprint ${blueprintId} (${yamlText.length} bytes) to marketplace (dryRun=${Boolean(payload.dryRun)})`,
        );

        const outcome = await publishAndForget({
          assetType: "blueprint",
          name: payload.name,
          description: payload.description,
          contentBuffer: Buffer.from(yamlText, "utf8"),
          contentMimeType: "application/x-yaml",
          metadata: {
            blueprintId,
            category: payload.category ?? "ai-workflow",
            yamlBytes: yamlText.length,
            tags: payload.tags ?? [],
          },
          priceUsdc:
            typeof payload.price === "number" ? payload.price / 100 : undefined,
          royaltyBps:
            typeof (payload as { royaltyBps?: number }).royaltyBps === "number"
              ? (payload as { royaltyBps?: number }).royaltyBps
              : undefined,
          dryRun: payload.dryRun,
        });

        return {
          assetId: outcome.tokenId ?? `pending-${Date.now()}`,
          assetUrl:
            outcome.marketplaceUrl ??
            (outcome.tokenId
              ? `https://joymarketplace.io/asset/${outcome.tokenId}`
              : ""),
          status: outcome.ok
            ? outcome.dryRun
              ? "draft"
              : "published"
            : "draft",
          onchain: outcome,
        } as PublishResult & { onchain: PublishOutcome };
      },
    ),
  );
}
