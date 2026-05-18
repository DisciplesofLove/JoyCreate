/**
 * Genius Core — Adapter quality scoring & auto-rollback hooks.
 *
 * Wraps the `genius-core:*-eval-set` and `genius-core:list-adapter-scores`
 * IPC surface in TanStack Query. Renderers use these in the Genius Core
 * control panel to configure the per-project eval set and visualise the
 * recent score history that gates auto-rollback decisions in the
 * distillation scheduler.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { IpcClient } from "@/ipc/ipc_client";
import type {
  AdapterScoreRow,
  EvalSet,
} from "@/lib/genius_core/adapter_evaluator";
import { showError, showSuccess } from "@/lib/toast";

const ipc = () => IpcClient.getInstance();

export const geniusCoreEvalKeys = {
  all: ["genius-core", "eval"] as const,
  set: (projectId: number) =>
    [...geniusCoreEvalKeys.all, "set", projectId] as const,
  scores: (projectId: number) =>
    [...geniusCoreEvalKeys.all, "scores", projectId] as const,
};

export function useGeniusCoreEvalSet(projectId: number | null | undefined) {
  return useQuery<EvalSet | null>({
    queryKey: geniusCoreEvalKeys.set(projectId ?? 0),
    queryFn: () => {
      if (!projectId) return Promise.resolve(null);
      return ipc().geniusCoreGetEvalSet(projectId);
    },
    enabled: Number.isInteger(projectId) && (projectId ?? 0) > 0,
    staleTime: 30_000,
  });
}

export function useSetGeniusCoreEvalSet() {
  const qc = useQueryClient();
  return useMutation<
    EvalSet | null,
    Error,
    { projectId: number; prompts: string[]; expectedKeywords: string[][] }
  >({
    mutationFn: (args) => {
      if (!Number.isInteger(args.projectId) || args.projectId <= 0) {
        throw new Error("projectId must be a positive integer");
      }
      if (!Array.isArray(args.prompts) || args.prompts.length === 0) {
        throw new Error("eval set requires at least one prompt");
      }
      if (
        !Array.isArray(args.expectedKeywords) ||
        args.expectedKeywords.length !== args.prompts.length
      ) {
        throw new Error("expectedKeywords must match prompts length");
      }
      return ipc().geniusCoreSetEvalSet(args);
    },
    onSuccess: (data, vars) => {
      qc.setQueryData(geniusCoreEvalKeys.set(vars.projectId), data);
      qc.invalidateQueries({
        queryKey: geniusCoreEvalKeys.set(vars.projectId),
      });
      showSuccess("Eval set updated");
    },
    onError: (err) => {
      showError(`Failed to save eval set: ${err.message}`);
    },
  });
}

export function useGeniusCoreAdapterScores(
  projectId: number | null | undefined,
  opts?: { limit?: number },
) {
  return useQuery<AdapterScoreRow[]>({
    queryKey: [
      ...geniusCoreEvalKeys.scores(projectId ?? 0),
      opts?.limit ?? 50,
    ] as const,
    queryFn: () => {
      if (!projectId) return Promise.resolve([]);
      return ipc().geniusCoreListAdapterScores({
        projectId,
        limit: opts?.limit ?? 50,
      });
    },
    enabled: Number.isInteger(projectId) && (projectId ?? 0) > 0,
    staleTime: 5_000,
  });
}

export function useSetGeniusCoreRollbackThreshold() {
  return useMutation<number, Error, number>({
    mutationFn: (threshold) => {
      if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
        throw new Error("threshold must be a number in [0, 1]");
      }
      return ipc().geniusCoreSetRollbackThreshold(threshold);
    },
    onSuccess: (value) => {
      showSuccess(
        value === 0
          ? "Adapter auto-rollback disabled"
          : `Adapter auto-rollback threshold set to ${(value * 100).toFixed(0)}%`,
      );
    },
    onError: (err) => {
      showError(`Failed to set rollback threshold: ${err.message}`);
    },
  });
}
