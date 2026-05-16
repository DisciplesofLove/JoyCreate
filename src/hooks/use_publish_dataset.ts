/**
 * Phase 1D — Dataset publish hook.
 *
 * Wraps `dataset:publish-to-marketplace` IPC channel. Existing local/p2p
 * dataset workflows are untouched — this is purely additive on-chain
 * publish path that returns a PublishOutcome from the orchestrator.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  IpcClient,
  type DatasetPublishArgs,
  type StudioPublishOutcome,
} from "@/ipc/ipc_client";

export function usePublishDataset() {
  const queryClient = useQueryClient();

  return useMutation<StudioPublishOutcome, Error, DatasetPublishArgs>({
    mutationFn: async (args) => {
      if (!args.datasetId) {
        throw new Error("datasetId is required");
      }
      return IpcClient.getInstance().publishDataset(args);
    },
    onSuccess: (outcome, variables) => {
      if (outcome.ok) {
        toast.success(
          outcome.dryRun
            ? "Dataset publish dry run complete"
            : "Dataset published to marketplace",
        );
      } else {
        const firstError = outcome.errors?.[0]?.message ?? "Unknown error";
        toast.error(`Dataset publish failed: ${firstError}`);
      }
      // Invalidate any dataset listing queries that may be visible.
      queryClient.invalidateQueries({ queryKey: ["studio-datasets"] });
      queryClient.invalidateQueries({
        queryKey: ["studio-dataset", variables.datasetId],
      });
    },
    onError: (err) => {
      toast.error(`Dataset publish failed: ${err.message}`);
    },
  });
}
