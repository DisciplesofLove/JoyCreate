import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { IpcClient } from "@/ipc/ipc_client";
import type { StudioJobDto, StudioJobEvent } from "@/ipc/ipc_client";

/**
 * Subscribes to the async studio job queue (`studio:job-progress`) and keeps a
 * live map of in-flight job events, while also exposing the persisted job list
 * via TanStack Query. Job completion automatically invalidates the relevant
 * caches (the video gallery for `generate-video` jobs, plus the job list).
 *
 * Imperative starters (`generateVideo`) return the job id so a caller can track
 * one specific job through `events.get(jobId)`.
 */
export function useStudioJobs() {
  const queryClient = useQueryClient();
  const [events, setEvents] = useState<Map<string, StudioJobEvent>>(new Map());
  const queryClientRef = useRef(queryClient);
  queryClientRef.current = queryClient;

  // Persisted history (and recovery of jobs from a previous session).
  const { data: jobs = [] } = useQuery<StudioJobDto[]>({
    queryKey: ["studio-jobs", "list"],
    queryFn: () => IpcClient.getInstance().listStudioJobs({ limit: 50 }),
    staleTime: 5_000,
  });

  useEffect(() => {
    const off = IpcClient.getInstance().onStudioJobProgress((evt) => {
      setEvents((prev) => {
        const next = new Map(prev);
        next.set(evt.id, evt);
        return next;
      });

      if (
        evt.status === "succeeded" ||
        evt.status === "failed" ||
        evt.status === "canceled"
      ) {
        const qc = queryClientRef.current;
        qc.invalidateQueries({ queryKey: ["studio-jobs", "list"] });
        if (evt.kind === "generate-video" && evt.status === "succeeded") {
          qc.invalidateQueries({ queryKey: ["video-studio", "list"] });
        }
      }
    });
    return off;
  }, []);

  const generateVideo = useCallback(
    async (
      params: Parameters<IpcClient["generateVideoAsync"]>[0],
    ): Promise<string> => {
      const { jobId } = await IpcClient.getInstance().generateVideoAsync(params);
      return jobId;
    },
    [],
  );

  const cancel = useCallback(async (id: string) => {
    await IpcClient.getInstance().cancelStudioJob(id);
  }, []);

  const activeJobs = jobs.filter(
    (j) => j.status === "queued" || j.status === "running",
  );

  return { jobs, activeJobs, events, generateVideo, cancel };
}
