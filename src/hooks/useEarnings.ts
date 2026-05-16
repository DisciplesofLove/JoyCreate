/**
 * useEarnings — Phase 1B hooks for the earnings ledgers.
 *
 * Reads from the new `agent_rental_earnings` and `subscription_earnings`
 * tables via IPC. Until those tables get populated by their writer
 * subsystems, queries simply return empty arrays.
 */

import { useQuery } from "@tanstack/react-query";

import { IpcClient } from "@/ipc/ipc_client";

export const EARNINGS_AGENTS_QUERY_KEY = ["earnings", "agent-rentals"] as const;
export const EARNINGS_SUBS_QUERY_KEY = ["earnings", "subscriptions"] as const;
export const EARNINGS_SUMMARY_QUERY_KEY = ["earnings", "summary"] as const;

export function useAgentRentalEarnings(args?: { limit?: number }) {
  return useQuery({
    queryKey: [...EARNINGS_AGENTS_QUERY_KEY, args?.limit ?? 200],
    queryFn: () => IpcClient.getInstance().listAgentRentalEarnings(args),
    staleTime: 30_000,
  });
}

export function useSubscriptionEarnings(args?: { limit?: number }) {
  return useQuery({
    queryKey: [...EARNINGS_SUBS_QUERY_KEY, args?.limit ?? 200],
    queryFn: () => IpcClient.getInstance().listSubscriptionEarnings(args),
    staleTime: 30_000,
  });
}

export function useEarningsSummary() {
  return useQuery({
    queryKey: EARNINGS_SUMMARY_QUERY_KEY,
    queryFn: () => IpcClient.getInstance().getEarningsSummary(),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}
