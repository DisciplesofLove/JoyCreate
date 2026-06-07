/**
 * Model Publish Hooks — license a registered model to our JoyMarketplace store
 * via the on-chain `model-registry:publish-to-marketplace` channel (manifest pin
 * -> mint -> EditionController store drop on Arbitrum).
 *
 * This is distinct from the legacy `usePublishModel` (which bundles an ad-hoc
 * adapter by path) and from the P2P `model-registry:publish` (decentralized
 * pin + Celestia attest). It adapts the dedicated ModelRegistryClient into the
 * generic asset-publish factory so call sites match agents/apps/workflows.
 *
 * The model id MUST be passed via `payload.sourceId`.
 */

import {
  makeUsePublishAsset,
  type PublishAssetConfig,
} from "./use_publish_asset";
import type { PublishResult } from "@/types/publish_types";
import { ModelRegistryClient } from "../ipc/model_registry_client";

const modelClient = ModelRegistryClient.getInstance();

export const modelPublishConfig: PublishAssetConfig<string> = {
  queryKey: "model-registry",
  publish: async (payload): Promise<PublishResult> => {
    const outcome = await modelClient.publishToMarketplace({
      modelId: String(payload.sourceId),
      name: payload.name,
      description: payload.description,
      // payload.price is in CENTS (legacy convention); orchestrator wants dollars.
      priceUsdc:
        typeof payload.price === "number" ? payload.price / 100 : undefined,
      category:
        typeof payload.category === "string" ? payload.category : undefined,
      license: payload.license,
      storeSlug: (payload as { storeSlug?: string }).storeSlug,
      dryRun: (payload as { dryRun?: boolean }).dryRun,
    });

    const tokenId = outcome.publish.tokenId;
    return {
      assetId: tokenId ?? outcome.dropId ?? `pending-${Date.now()}`,
      assetUrl:
        outcome.marketplaceUrl ??
        (tokenId ? `https://joymarketplace.io/asset/${tokenId}` : ""),
      status: outcome.ok ? (outcome.dryRun ? "draft" : "published") : "draft",
    };
  },
  unpublish: async () => {
    throw new Error(
      "Model unpublish is not implemented — each publish mints a new on-chain token.",
    );
  },
};

export const usePublishModelToMarketplace = makeUsePublishAsset(modelPublishConfig);
