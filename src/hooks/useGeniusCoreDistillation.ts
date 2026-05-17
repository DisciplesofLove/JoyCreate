/**
 * Genius Core — Continuous Distillation React Hooks
 *
 * TanStack Query bindings for the `genius-core:distillation-*` IPC surface:
 *
 *   • `useGeniusCoreDistillationStatus` — live status snapshot.
 *   • `useRunGeniusCoreDistillation`    — manual trigger on a project.
 *   • `useSetGeniusCoreDistillationEnabled` — toggle the nightly gate.
 *
 * The mutation hooks invalidate the status query on success and surface
 * errors through the shared toast helpers.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { IpcClient } from "@/ipc/ipc_client";
import type { GeniusCoreDistillationReceiptDto } from "@/ipc/handlers/genius_core_handlers";
import type { DistillationStatus } from "@/lib/genius_core/distillation_scheduler";
import { showError, showSuccess } from "@/lib/toast";

const ipc = () => IpcClient.getInstance();

export const geniusCoreDistillationKeys = {
  all: ["genius-core", "distillation"] as const,
  status: () => [...geniusCoreDistillationKeys.all, "status"] as const,
};

export function useGeniusCoreDistillationStatus(opts?: { refetchMs?: number }) {
  return useQuery<DistillationStatus>({
    queryKey: geniusCoreDistillationKeys.status(),
    queryFn: () => ipc().geniusCoreDistillationStatus(),
    refetchInterval: opts?.refetchMs ?? 15_000,
    staleTime: 5_000,
  });
}

export function useRunGeniusCoreDistillation() {
  const qc = useQueryClient();
  return useMutation<GeniusCoreDistillationReceiptDto, Error, number>({
    mutationFn: (projectId: number) => {
      if (!Number.isInteger(projectId) || projectId <= 0) {
        throw new Error("projectId must be a positive integer");
      }
      return ipc().geniusCoreDistillationRunNow(projectId);
    },
    onSuccess: (receipt) => {
      qc.invalidateQueries({ queryKey: geniusCoreDistillationKeys.status() });
      showSuccess(
        `Distillation completed — adapter ${receipt.adapterId} (${receipt.sampleCount} samples)`,
      );
    },
    onError: (err) => {
      showError(`Distillation failed: ${err.message}`);
    },
  });
}

export function useSetGeniusCoreDistillationEnabled() {
  const qc = useQueryClient();
  return useMutation<DistillationStatus, Error, boolean>({
    mutationFn: (enabled: boolean) =>
      ipc().geniusCoreDistillationSetEnabled(enabled),
    onSuccess: (status, enabled) => {
      qc.setQueryData(geniusCoreDistillationKeys.status(), status);
      qc.invalidateQueries({ queryKey: geniusCoreDistillationKeys.status() });
      showSuccess(
        enabled
          ? "Nightly distillation enabled"
          : "Nightly distillation disabled",
      );
    },
    onError: (err) => {
      showError(`Failed to update distillation setting: ${err.message}`);
    },
  });
}
