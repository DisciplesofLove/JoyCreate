/**
 * TanStack Query hook for JNS (Joy Name System) name resolution.
 *
 * JNS is the sibling of ENS — it resolves `.joy` names (and the Arbitrum
 * `joymarketplace.io` deployment) to an owner, address, and creator text
 * records. Backed by the `jns:resolve-name` IPC channel registered in
 * src/ipc/handlers/jns_handlers.ts.
 */

import { useQuery } from "@tanstack/react-query";

import { IpcClient, type JnsChainId, type JnsResolution } from "@/ipc/ipc_client";

const ipc = IpcClient.getInstance();

/**
 * Resolve a JNS name. The query is disabled until a non-empty name is
 * supplied. When `chain` is omitted the resolver infers it from the name
 * suffix (`.joy` → Amoy, `.joymarketplace.io` → Arbitrum Sepolia).
 */
export function useJnsResolve(name: string | undefined, chain?: JnsChainId) {
  return useQuery<JnsResolution>({
    queryKey: ["jns", "resolve", chain ?? "auto", name],
    queryFn: () => ipc.jnsResolveName({ name: name!, chain }),
    enabled: Boolean(name && name.trim()),
  });
}
