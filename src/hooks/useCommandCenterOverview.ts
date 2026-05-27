/**
 * React Query hook for the unified Command Center overview.
 *
 * Refetches every 30s so the dashboard stays fresh without manual reloads.
 */

import { useQuery } from "@tanstack/react-query";
import { IpcClient } from "@/ipc/ipc_client";
import type { CommandCenterOverview } from "@/ipc/handlers/command_center_handlers";

export const COMMAND_CENTER_KEY = ["command-center", "overview"] as const;

export function useCommandCenterOverview() {
  return useQuery<CommandCenterOverview>({
    queryKey: COMMAND_CENTER_KEY,
    queryFn: () => IpcClient.getInstance().getCommandCenterOverview(),
    refetchInterval: 30_000,
    staleTime: 15_000,
  });
}
