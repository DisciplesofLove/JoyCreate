/**
 * LRA listing hook — list a runtime-bearing local entity (agent / app) as a
 * Licensed Runtime Asset via the `marketplace:list-entity` IPC channel
 * (author + pin the runtime → attach to an ERC-8004 agent card → mirror into
 * the A2A economy).
 *
 * This is the on-chain *runtime* rail (ERC-8004 + A2A), distinct from the
 * JoyMarketplace ERC-1155 publish path (`usePublishAgent` / `usePublishApp`),
 * which mints a sellable edition. Both can apply to the same entity.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";

import { IpcClient, type MarketplaceListEntityResult } from "@/ipc/ipc_client";
import { showError, showSuccess } from "@/lib/toast";

const client = IpcClient.getInstance();

export interface ListRuntimeAssetVars {
  kind: "agent" | "app";
  entityId: number;
  chain?: "arbitrumSepolia" | "arbitrumOne";
  erc8004AgentId?: string;
  cardName?: string;
  agentOptions?: {
    modelId?: string;
    systemPrompt?: string;
    promptTemplate?: string;
    maxTokens?: number;
    temperature?: number;
  };
  bridgeToA2a?: boolean;
  pricing?: {
    pricingModel?: "free" | "fixed" | "per_token" | "per_call" | "subscription";
    priceAmount?: string;
    currency?: "JOY" | "TIA" | "USDC" | "MATIC" | "points";
  };
}

/**
 * Mutation that lists an agent or app as a Licensed Runtime Asset. On success
 * it invalidates the entity's cache (and the agents cache, since an app lists
 * through its owning agent) so publish state refreshes.
 */
export function useListRuntimeAsset() {
  const queryClient = useQueryClient();
  return useMutation<MarketplaceListEntityResult, Error, ListRuntimeAssetVars>({
    mutationFn: (vars) => {
      if (!Number.isInteger(vars.entityId) || vars.entityId <= 0) {
        throw new Error("entityId must be a positive integer");
      }
      return client.marketplaceListEntity(vars);
    },
    onSuccess: (result, vars) => {
      showSuccess(
        result.bridge
          ? `Listed as runtime asset (skillCid ${result.skill.skillCid.slice(0, 12)}…, A2A listing ${result.bridge.listingId})`
          : `Listed as runtime asset (skillCid ${result.skill.skillCid.slice(0, 12)}…)`,
      );
      queryClient.invalidateQueries({ queryKey: [vars.kind === "app" ? "apps" : "agents"] });
      queryClient.invalidateQueries({ queryKey: ["agents"] });
      queryClient.invalidateQueries({ queryKey: ["earnings"] });
    },
    onError: (error) => {
      showError(error instanceof Error ? error : new Error(String(error)));
    },
  });
}
