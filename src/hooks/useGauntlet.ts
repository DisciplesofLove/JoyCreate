/**
 * React hooks for the Left Gauntlet IPC surface.
 */

import { useEffect, useMemo } from "react";
import { atom, useAtomValue, useSetAtom } from "jotai";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { IpcClient, type GauntletProgressEvent } from "@/ipc/ipc_client";

const ipc = () => IpcClient.getInstance();

const QK = {
  runs: (limit: number) => ["gauntlet", "runs", limit] as const,
  run: (id: string) => ["gauntlet", "run", id] as const,
  sessions: ["gauntlet", "sessions"] as const,
};

/** Live, in-memory progress events keyed by runId. Cleared when a run terminates. */
export const gauntletActiveRunsAtom = atom<
  Record<string, GauntletProgressEvent>
>({});

export function useGauntletProgressBus(): void {
  const setRuns = useSetAtom(gauntletActiveRunsAtom);
  useEffect(() => {
    const unsub = ipc().onGauntletProgress((evt) => {
      setRuns((prev) => ({ ...prev, [evt.runId]: evt }));
    });
    return unsub;
  }, [setRuns]);
}

export function useGauntletActiveProgress(runId: string | null) {
  const all = useAtomValue(gauntletActiveRunsAtom);
  return useMemo(() => (runId ? all[runId] : undefined), [all, runId]);
}

export function useGauntletRuns(limit = 100) {
  return useQuery({
    queryKey: QK.runs(limit),
    queryFn: () => ipc().listGauntletRuns(limit),
  });
}

export function useGauntletRun(runId: string | null) {
  return useQuery({
    queryKey: QK.run(runId ?? ""),
    queryFn: () => ipc().getGauntletRun(runId!),
    enabled: !!runId,
  });
}

export function useGauntletSessions() {
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: QK.sessions,
    queryFn: () => ipc().listGauntletSessions(),
  });
  const create = useMutation({
    mutationFn: (input: {
      label: string;
      originPattern: string;
      loginUrl: string;
    }) => ipc().createGauntletSession(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: QK.sessions }),
    onError: (e) => toast.error((e as Error).message),
  });
  const remove = useMutation({
    mutationFn: (id: string) => ipc().deleteGauntletSession(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: QK.sessions }),
    onError: (e) => toast.error((e as Error).message),
  });
  return { list, create, remove };
}

export function useGauntletExecute() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Parameters<IpcClient["runGauntlet"]>[0]) =>
      ipc().runGauntlet(input),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["gauntlet", "runs"] });
      if (res.status === "succeeded") {
        toast.success(
          `Gauntlet anchored ${res.markdownCid?.slice(0, 12)}…`,
        );
      } else if (res.status === "denied") {
        toast.error(
          `Whitehat blocked: ${res.errorMessage ?? "integrity violation"}`,
        );
      } else {
        toast.error(
          `Gauntlet failed: ${res.errorMessage ?? res.errorCode ?? "unknown"}`,
        );
      }
    },
    onError: (e) => toast.error((e as Error).message),
  });
}

export function useGauntletVerify() {
  return useMutation({
    mutationFn: (input: { markdown: string; intent: string; model?: string }) =>
      ipc().verifyGauntletMarkdown(input),
    onError: (e) => toast.error((e as Error).message),
  });
}

export function useGauntletPing() {
  const firecrawl = useMutation({
    mutationFn: () => ipc().testGauntletFirecrawl(),
    onSuccess: () => toast.success("Firecrawl OK"),
    onError: (e) => toast.error(`Firecrawl: ${(e as Error).message}`),
  });
  const ollama = useMutation({
    mutationFn: () => ipc().testGauntletOllama(),
    onSuccess: (r) => toast.success(`Ollama OK — ${r.models.length} models`),
    onError: (e) => toast.error(`Ollama: ${(e as Error).message}`),
  });
  return { firecrawl, ollama };
}
