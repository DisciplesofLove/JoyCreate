/**
 * Phase 1D — Dataset monetization + purchase hooks.
 *
 * `useMonetizeDataset` wraps `dataset:monetize`: it publishes a dataset to the
 * marketplace AND creates an x402-purchasable EditionController drop, persisting
 * the resulting DataMonetization onto the dataset row.
 *
 * `usePurchaseDataset` wraps `dataset:purchase`: pay-per-mint a monetized
 * dataset through the x402 settlement rail.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  IpcClient,
  type DatasetMonetizeArgs,
  type DatasetMonetizeOutcome,
  type DatasetPurchaseResult,
} from "@/ipc/ipc_client";

export function useMonetizeDataset() {
  const queryClient = useQueryClient();

  return useMutation<DatasetMonetizeOutcome, Error, DatasetMonetizeArgs>({
    mutationFn: async (args) => {
      if (!args.datasetId) {
        throw new Error("datasetId is required");
      }
      if (typeof args.priceUsdc !== "number" || args.priceUsdc < 0) {
        throw new Error("priceUsdc must be a non-negative number");
      }
      if (!args.storeSlug) {
        throw new Error("storeSlug is required");
      }
      return IpcClient.getInstance().monetizeDataset(args);
    },
    onSuccess: (outcome, variables) => {
      if (outcome.ok) {
        toast.success(
          outcome.dryRun
            ? "Dataset monetize dry run complete"
            : outcome.dropId
              ? "Dataset published and x402 drop created"
              : "Dataset published (x402 drop pending)",
        );
        if (!outcome.dryRun && !outcome.dropId && outcome.errors.length) {
          toast.warning(`x402 drop not created: ${outcome.errors[0]}`);
        }
      } else {
        toast.error(`Dataset monetize failed: ${outcome.errors[0] ?? "Unknown error"}`);
      }
      queryClient.invalidateQueries({ queryKey: ["studio-datasets"] });
      queryClient.invalidateQueries({
        queryKey: ["studio-dataset", variables.datasetId],
      });
    },
    onError: (err) => {
      toast.error(`Dataset monetize failed: ${err.message}`);
    },
  });
}

export function usePurchaseDataset() {
  const queryClient = useQueryClient();

  return useMutation<DatasetPurchaseResult, Error, { datasetId: string }>({
    mutationFn: async (args) => {
      if (!args.datasetId) {
        throw new Error("datasetId is required");
      }
      return IpcClient.getInstance().purchaseDataset(args);
    },
    onSuccess: (result, variables) => {
      toast.success(`Dataset purchased — minted edition #${result.tokenId}`);
      queryClient.invalidateQueries({ queryKey: ["studio-datasets"] });
      queryClient.invalidateQueries({
        queryKey: ["studio-dataset", variables.datasetId],
      });
    },
    onError: (err) => {
      toast.error(`Dataset purchase failed: ${err.message}`);
    },
  });
}
