import { useQuery } from "@tanstack/react-query";
import { IpcClient } from "@/ipc/ipc_client";
import type { GitDiffResult } from "@/ipc/ipc_types";

/**
 * Fetch the diff for a single app version (what the commit changed vs its
 * parent). Only runs when both an appId and versionId are provided and
 * `enabled` is true (so the diff is loaded lazily when a diff view is opened).
 */
export function useVersionDiff(
  appId: number | null,
  versionId: string | null,
  enabled = true,
) {
  return useQuery<GitDiffResult, Error>({
    queryKey: ["version-diff", appId, versionId],
    queryFn: async (): Promise<GitDiffResult> => {
      if (appId === null || !versionId) {
        return { patch: "", files: [], insertions: 0, deletions: 0 };
      }
      return IpcClient.getInstance().getVersionDiff({
        appId,
        versionId,
      });
    },
    enabled: enabled && appId !== null && !!versionId,
    staleTime: 60_000,
    meta: { showErrorToast: true },
  });
}
