/**
 * Generic Asset Publish Hook Factory — TanStack Query mutations for
 * publishing/unpublishing assets (agents, workflows, …) to JoyMarketplace
 * via the on-chain DropERC1155 lazy-mint orchestrator.
 *
 * Section B verification (briefs/droperc1155-read-layer-surgery.md):
 *   These mutations are write-side only. They route through the
 *   appropriate `<asset>:publish-to-marketplace` IPC channel and on
 *   success invalidate the asset's query cache plus the creator
 *   dashboard cache. There is NO post-publish read against MarketplaceV3
 *   listings, NO call to `marketplace-sync:*`, and NO Supabase
 *   listing-mirror confirmation.
 *
 * Per-asset wrappers in `use_publish_agent.ts` and `use_publish_workflow.ts`
 * preserve the existing call sites.
 */

import {
  useMutation,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import { IpcClient } from "../ipc/ipc_client";
import type {
  UnifiedPublishPayload,
  PublishResult,
} from "@/types/publish_types";
import { showError } from "@/lib/toast";
import { creatorKeys } from "./use_creator_dashboard";

const client = IpcClient.getInstance();

interface PublishAssetConfig<TId> {
  /** TanStack Query key prefix to invalidate on success (e.g. "agents"). */
  queryKey: string;
  /** IPC method that publishes the asset and returns a PublishResult. */
  publish: (payload: UnifiedPublishPayload) => Promise<PublishResult>;
  /** IPC method that unpublishes the asset by id. */
  unpublish: (id: TId) => Promise<void>;
}

function reportError(error: unknown): void {
  showError(error instanceof Error ? error : new Error(String(error)));
}

/**
 * Build a `usePublishX` hook for an asset type.
 */
export function makeUsePublishAsset<TId>(
  config: PublishAssetConfig<TId>,
): () => UseMutationResult<PublishResult, Error, UnifiedPublishPayload> {
  return function usePublishAsset() {
    const queryClient = useQueryClient();
    return useMutation<PublishResult, Error, UnifiedPublishPayload>({
      mutationFn: (payload) => config.publish(payload),
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: [config.queryKey] });
        queryClient.invalidateQueries({ queryKey: creatorKeys.all });
      },
      onError: reportError,
    });
  };
}

/**
 * Build a `useUnpublishX` hook for an asset type.
 */
export function makeUseUnpublishAsset<TId>(
  config: PublishAssetConfig<TId>,
): () => UseMutationResult<void, Error, TId> {
  return function useUnpublishAsset() {
    const queryClient = useQueryClient();
    return useMutation<void, Error, TId>({
      mutationFn: (id) => config.unpublish(id),
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: [config.queryKey] });
        queryClient.invalidateQueries({ queryKey: creatorKeys.all });
      },
      onError: reportError,
    });
  };
}

export const agentPublishConfig: PublishAssetConfig<number> = {
  queryKey: "agents",
  publish: (payload) => client.agentPublishToMarketplace(payload),
  unpublish: (id) => client.agentUnpublish(id),
};

export const workflowPublishConfig: PublishAssetConfig<string> = {
  queryKey: "workflows",
  publish: (payload) => client.workflowPublishToMarketplace(payload),
  unpublish: (id) => client.workflowUnpublish(id),
};
