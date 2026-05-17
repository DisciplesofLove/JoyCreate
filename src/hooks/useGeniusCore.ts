/**
 * Genius Core React Hooks
 *
 * TanStack Query bindings for the `genius-core:*` IPC surface. Reads are
 * `useQuery`, writes are `useMutation` with proper invalidation of the
 * status / catalogue caches. Errors propagate via the shared toast helpers
 * so the UI never silently swallows a backend failure.
 *
 * Streaming inference is exposed as an imperative helper (`streamInfer`)
 * because TanStack Query is not the right primitive for token-by-token
 * subscriptions — wrap the helper in a component-local state hook.
 */

import { useCallback } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { IpcClient } from "@/ipc/ipc_client";
import type {
  GeniusCoreInferRequest,
  GeniusCoreInferResponse,
  GeniusCoreStatusReport,
} from "@/lib/genius_core";
import { showError, showSuccess } from "@/lib/toast";

const ipc = () => IpcClient.getInstance();

// ── Query keys ───────────────────────────────────────────────────────────

export const geniusCoreKeys = {
  all: ["genius-core"] as const,
  status: () => [...geniusCoreKeys.all, "status"] as const,
  baseModels: () => [...geniusCoreKeys.all, "base-models"] as const,
  projectSlot: (projectId: string) =>
    [...geniusCoreKeys.all, "project-slot", projectId] as const,
};

// ── Reads ────────────────────────────────────────────────────────────────

/**
 * Subscribe to the current Genius Core status. Defaults to a 5s
 * refetch interval while a window is mounted so the VRAM gauge etc.
 * stay live without explicit invalidation.
 */
export function useGeniusCoreStatus(opts?: { refetchMs?: number }) {
  return useQuery<GeniusCoreStatusReport>({
    queryKey: geniusCoreKeys.status(),
    queryFn: () => ipc().geniusCoreStatus(),
    refetchInterval: opts?.refetchMs ?? 5000,
    staleTime: 1000,
  });
}

/** Curated base-model catalogue. Static for the lifetime of the app. */
export function useGeniusCoreBaseModels() {
  return useQuery({
    queryKey: geniusCoreKeys.baseModels(),
    queryFn: () => ipc().geniusCoreListBaseModels(),
    staleTime: Number.POSITIVE_INFINITY,
  });
}

// ── Writes ───────────────────────────────────────────────────────────────

export function useInitGeniusCore() {
  const qc = useQueryClient();
  return useMutation<GeniusCoreStatusReport, Error, void>({
    mutationFn: () => ipc().geniusCoreInit(),
    onSuccess: (status) => {
      qc.setQueryData(geniusCoreKeys.status(), status);
      qc.invalidateQueries({ queryKey: geniusCoreKeys.status() });
      showSuccess("Genius Core initialized");
    },
    onError: (err) => {
      showError(`Genius Core init failed: ${err.message}`);
    },
  });
}

export function useLoadContextSlot() {
  const qc = useQueryClient();
  return useMutation<GeniusCoreStatusReport, Error, string>({
    mutationFn: (projectId: string) => {
      if (!projectId) throw new Error("projectId is required");
      return ipc().geniusCoreLoadContextSlot(projectId);
    },
    onSuccess: (status) => {
      qc.setQueryData(geniusCoreKeys.status(), status);
    },
    onError: (err) => {
      showError(`Context slot load failed: ${err.message}`);
    },
  });
}

export function useGeniusCoreInfer() {
  return useMutation<GeniusCoreInferResponse, Error, GeniusCoreInferRequest>({
    mutationFn: (req) => {
      if (!req?.prompt) throw new Error("prompt is required");
      return ipc().geniusCoreInfer(req);
    },
    onError: (err) => {
      showError(`Genius Core inference failed: ${err.message}`);
    },
  });
}

export function useSetGeniusCoreBaseModel() {
  const qc = useQueryClient();
  return useMutation<GeniusCoreStatusReport, Error, string>({
    mutationFn: (modelId: string) => {
      if (!modelId) throw new Error("modelId is required");
      return ipc().geniusCoreSetBaseModel(modelId);
    },
    onSuccess: (status) => {
      qc.setQueryData(geniusCoreKeys.status(), status);
      qc.invalidateQueries({ queryKey: geniusCoreKeys.status() });
      showSuccess("Genius Core base model updated");
    },
    onError: (err) => {
      showError(`Failed to set base model: ${err.message}`);
    },
  });
}

// ── Streaming helper ─────────────────────────────────────────────────────

/**
 * Returns an imperative `streamInfer` function. Each call wires up a
 * fresh `genius-core:stream-chunk` subscription, forwards tokens to
 * `onChunk`, and resolves with the final response (or rejects on error).
 *
 * Usage:
 * ```ts
 * const stream = useStreamGeniusCoreInfer();
 * const result = await stream({ prompt: "..." }, (tok) => setText(t => t + tok));
 * ```
 */
export function useStreamGeniusCoreInfer() {
  return useCallback(
    (req: GeniusCoreInferRequest, onChunk: (chunk: string) => void) => {
      if (!req?.prompt) {
        return Promise.reject(new Error("prompt is required"));
      }
      return ipc().geniusCoreStreamInfer(req, onChunk);
    },
    [],
  );
}

// ── Project context slot (Phase 4) ───────────────────────────────────────

/**
 * Fast read of the project's current context slot record. Disabled when
 * `projectId` is empty so route components can call this unconditionally.
 */
export function useGeniusCoreProjectSlot(projectId: string | null | undefined) {
  return useQuery({
    queryKey: geniusCoreKeys.projectSlot(projectId ?? ""),
    queryFn: () => ipc().geniusCorePeekProjectSlot(String(projectId)),
    enabled: Boolean(projectId),
    staleTime: 30_000,
  });
}

/**
 * Trigger a full context-slot open (fetches the IPLD block over Helia
 * and emits the domain event). Use on project navigation.
 */
export function useOpenGeniusCoreProjectSlot() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (projectId: string) => {
      if (!projectId) throw new Error("projectId is required");
      return ipc().geniusCoreOpenProjectSlot(projectId);
    },
    onSuccess: (info, projectId) => {
      qc.setQueryData(geniusCoreKeys.projectSlot(projectId), info);
    },
    onError: (err) => {
      showError(`Genius Core context slot failed to open: ${err.message}`);
    },
  });
}
