/**
 * React Query hooks for per-agent knowledge bases.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { IpcClient } from "@/ipc/ipc_client";

export interface KbDocument {
  id: string;
  collectionId: string;
  content: string;
  title?: string;
  source?: string;
  metadata?: Record<string, unknown>;
  chunkCount?: number;
  createdAt: string;
  updatedAt?: string;
}

export interface KbSearchResult {
  id: string;
  content: string;
  score: number;
  documentId: string;
  chunkIndex: number;
  title?: string;
  source?: string;
  metadata?: Record<string, unknown>;
}

const KB_KEY = ["agent-kb"] as const;

export function useAgentKbDocs(agentId: string | null) {
  return useQuery({
    queryKey: [...KB_KEY, agentId ?? "__none__"],
    queryFn: async (): Promise<KbDocument[]> => {
      if (!agentId) return [];
      const res = await IpcClient.getInstance().listAgentKbDocs(agentId);
      return res.documents;
    },
    enabled: !!agentId,
  });
}

export function useAddAgentKbText() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: {
      agentId: string;
      title: string;
      content: string;
      source?: string;
    }) => {
      if (!args.title.trim()) throw new Error("Title is required");
      if (!args.content.trim()) throw new Error("Content is required");
      const res = await IpcClient.getInstance().addAgentKbText(args);
      return res.document as KbDocument;
    },
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: [...KB_KEY, vars.agentId] });
    },
  });
}

export function useAddAgentKbUrl() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: {
      agentId: string;
      url: string;
      title?: string;
    }) => {
      if (!args.url.trim()) throw new Error("URL is required");
      const res = await IpcClient.getInstance().addAgentKbUrl(args);
      return res.document as KbDocument;
    },
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: [...KB_KEY, vars.agentId] });
    },
  });
}

export function useDeleteAgentKbDoc() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: { agentId: string; documentId: string }) => {
      await IpcClient.getInstance().deleteAgentKbDoc(args);
      return args;
    },
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: [...KB_KEY, vars.agentId] });
    },
  });
}

export function useClearAgentKb() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (agentId: string) => {
      await IpcClient.getInstance().clearAgentKb(agentId);
      return agentId;
    },
    onSuccess: (agentId) => {
      qc.invalidateQueries({ queryKey: [...KB_KEY, agentId] });
    },
  });
}

export function useSearchAgentKb() {
  return useMutation({
    mutationFn: async (args: {
      agentId: string;
      query: string;
      topK?: number;
    }): Promise<KbSearchResult[]> => {
      if (!args.query.trim()) throw new Error("Query is required");
      const res = await IpcClient.getInstance().searchAgentKb(args);
      return res.results;
    },
  });
}
