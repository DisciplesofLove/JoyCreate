/**
 * useCopilot — TanStack Query hooks for the NLP self-healing Copilot.
 *
 * Wraps `IpcClient.copilot*` methods with caching, mutations, and
 * a streaming-progress subscription helper.
 */

import { useEffect, useState } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { IpcClient } from "@/ipc/ipc_client";
import type { CopilotJobRow } from "@/db/copilot_schema";

const COPILOT_JOBS_KEY = ["copilot", "jobs"] as const;

export function useCopilotJobs(limit = 50) {
  return useQuery({
    queryKey: [...COPILOT_JOBS_KEY, limit],
    queryFn: async () =>
      (await IpcClient.getInstance().copilotListJobs(limit)) as CopilotJobRow[],
    refetchOnWindowFocus: true,
  });
}

export function useCopilotJob(jobId: string | undefined) {
  return useQuery({
    queryKey: ["copilot", "job", jobId],
    queryFn: async () =>
      jobId
        ? ((await IpcClient.getInstance().copilotGetJob(jobId)) as CopilotJobRow | null)
        : null,
    enabled: Boolean(jobId),
    refetchInterval: (query) => {
      const data = query.state.data as CopilotJobRow | null | undefined;
      // Poll while job is still moving so the UI tracks Claude/tool progress.
      if (data && (data.status === "running" || data.status === "pending")) {
        return 1500;
      }
      return false;
    },
  });
}

export function useCopilotAsk() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      prompt: string;
      routerModel?: string;
      claudeApiKey?: string;
    }) => IpcClient.getInstance().copilotAsk(input) as Promise<CopilotJobRow>,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: COPILOT_JOBS_KEY });
    },
    onError: (err: Error) =>
      toast.error(`Copilot request failed: ${err.message}`),
  });
}

export function useCopilotApprove() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { jobId: string; approverDid?: string }) =>
      IpcClient.getInstance().copilotApproveJob(input) as Promise<CopilotJobRow>,
    onSuccess: (job) => {
      qc.invalidateQueries({ queryKey: COPILOT_JOBS_KEY });
      qc.invalidateQueries({ queryKey: ["copilot", "job", job.id] });
      toast.success("Copilot job approved");
    },
    onError: (err: Error) => toast.error(`Approve failed: ${err.message}`),
  });
}

export function useCopilotReject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      jobId: string;
      approverDid?: string;
      reason?: string;
    }) => IpcClient.getInstance().copilotRejectJob(input) as Promise<CopilotJobRow>,
    onSuccess: (job) => {
      qc.invalidateQueries({ queryKey: COPILOT_JOBS_KEY });
      qc.invalidateQueries({ queryKey: ["copilot", "job", job.id] });
      toast.success("Copilot job rejected");
    },
    onError: (err: Error) => toast.error(`Reject failed: ${err.message}`),
  });
}

export function useCopilotCancel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { jobId: string }) =>
      IpcClient.getInstance().copilotCancelJob(input) as Promise<CopilotJobRow>,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: COPILOT_JOBS_KEY });
    },
    onError: (err: Error) => toast.error(`Cancel failed: ${err.message}`),
  });
}

/**
 * Subscribe to streaming progress events emitted while a copilot job runs.
 * Returns the most-recent N progress chunks; auto-clears between sessions.
 */
export function useCopilotProgress(maxChunks = 100) {
  const [chunks, setChunks] = useState<
    { stage: string; content: string; ts: number }[]
  >([]);

  useEffect(() => {
    const off = IpcClient.getInstance().onCopilotProgress((chunk) => {
      setChunks((prev) => {
        const next = [...prev, { ...chunk, ts: Date.now() }];
        return next.length > maxChunks ? next.slice(-maxChunks) : next;
      });
    });
    return off;
  }, [maxChunks]);

  const clear = () => setChunks([]);
  return { chunks, clear };
}
