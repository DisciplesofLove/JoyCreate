/**
 * TanStack Query hooks for the x402 pay-per-mint rail.
 *
 * Backed by the `x402:*` IPC channels (src/ipc/handlers/x402_handlers.ts).
 * See docs/payments/ for the revenue-split program these hooks surface.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  IpcClient,
  type X402ChainId,
  type X402PurchaseResult,
  type X402Status,
} from "@/ipc/ipc_client";
import { showError } from "@/lib/toast";

const ipc = IpcClient.getInstance();

/** Splitter readiness + split config + payout address for a chain. */
export function useX402Status(chain?: X402ChainId) {
  return useQuery<X402Status>({
    queryKey: ["x402", "status", chain ?? "default"],
    queryFn: () => ipc.x402Status(chain ? { chain } : undefined),
  });
}

/** End-to-end purchase (pay → settle → mint) of an EditionController drop. */
export function useX402PurchaseEdition() {
  const queryClient = useQueryClient();
  return useMutation<X402PurchaseResult, Error, { chain?: X402ChainId; dropId: string }>({
    mutationFn: (args) => ipc.x402PurchaseEdition(args),
    onSuccess: () => {
      // Supply/earnings changed on-chain — refresh blueprint + earnings reads.
      void queryClient.invalidateQueries({ queryKey: ["broker"] });
      void queryClient.invalidateQueries({ queryKey: ["x402"] });
    },
    onError: (error) => {
      showError(error instanceof Error ? error : new Error(String(error)));
    },
  });
}
