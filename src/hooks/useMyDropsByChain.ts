/**
 * Renderer hook: fetch a wallet's published drops from the chain-aware
 * Goldsky subgraph (`marketplace:my-drops`).
 *
 * Returns the same `MarketplaceBrowseResult` shape as the marketplace
 * browse handler, so the caller can render with the existing card UI.
 *
 * The query is gated on `wallet != null` — pass `null` when the user has
 * no connected wallet and the hook will stay idle.
 */
import { useQuery } from "@tanstack/react-query";
import { IpcClient } from "@/ipc/ipc_client";
import type {
  MarketplaceBrowseResult,
  MarketplaceSubgraphChainId,
} from "@/types/publish_types";

export const myDropsByChainKeys = {
  all: ["marketplace", "my-drops-by-chain"] as const,
  list: (
    wallet: string | null,
    chainId: MarketplaceSubgraphChainId,
    page: number,
    pageSize: number,
  ) =>
    [...myDropsByChainKeys.all, wallet?.toLowerCase() ?? null, chainId, page, pageSize] as const,
};

export interface UseMyDropsByChainOptions {
  wallet: string | null;
  chainId: MarketplaceSubgraphChainId;
  page?: number;
  pageSize?: number;
  enabled?: boolean;
}

export function useMyDropsByChain({
  wallet,
  chainId,
  page = 1,
  pageSize = 24,
  enabled = true,
}: UseMyDropsByChainOptions) {
  return useQuery<MarketplaceBrowseResult>({
    queryKey: myDropsByChainKeys.list(wallet, chainId, page, pageSize),
    enabled: enabled && typeof wallet === "string" && wallet.length > 0,
    queryFn: async () => {
      if (!wallet) {
        // Defensive — `enabled` should already prevent this branch.
        throw new Error("wallet is required");
      }
      return IpcClient.getInstance().marketplaceMyDrops({
        wallet,
        chainId,
        page,
        pageSize,
      });
    },
  });
}
