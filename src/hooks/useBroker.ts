/**
 * TanStack Query hooks for the ERC-1144 interface broker — fetch machine-
 * readable interface blueprints for stores, drops and agents.
 * Backed by the IPC channels registered in
 *   src/ipc/handlers/broker_handlers.ts
 */

import { useQuery } from "@tanstack/react-query";

import {
  IpcClient,
  type InterfaceBlueprint,
  type X402ChainId,
} from "@/ipc/ipc_client";

const ipc = IpcClient.getInstance();

export function useDropBlueprint(dropId: string | undefined, chain?: X402ChainId) {
  return useQuery<InterfaceBlueprint>({
    queryKey: ["broker", "drop", chain ?? "default", dropId],
    queryFn: () => ipc.brokerDropBlueprint({ chain, dropId: dropId! }),
    enabled: Boolean(dropId),
  });
}

export function useStoreBlueprint(storeId: string | undefined, chain?: X402ChainId) {
  return useQuery<InterfaceBlueprint>({
    queryKey: ["broker", "store", chain ?? "default", storeId],
    queryFn: () => ipc.brokerStoreBlueprint({ chain, storeId: storeId! }),
    enabled: Boolean(storeId),
  });
}

export function useAgentBlueprint(agentId: string | undefined, chain?: X402ChainId) {
  return useQuery<InterfaceBlueprint>({
    queryKey: ["broker", "agent", chain ?? "default", agentId],
    queryFn: () => ipc.brokerAgentBlueprint({ chain, agentId: agentId! }),
    enabled: Boolean(agentId),
  });
}
