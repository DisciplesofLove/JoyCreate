/**
 * React Query hooks for the agent template gallery.
 *
 * - useAgentTemplates(category?)        — full template list
 * - useFeaturedAgentTemplates()         — curated tiles for the gallery
 * - useCreateAgentFromTemplate()        — one-click "Use template"
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { IpcClient } from "@/ipc/ipc_client";

export interface AgentTemplateSummary {
  id: string;
  name: string;
  description?: string;
  category: string;
  featured?: boolean;
  thumbnail?: string;
  agent: any;
}

const TEMPLATES_KEY = ["agent-templates"] as const;
const FEATURED_KEY = ["agent-templates", "featured"] as const;

export function useAgentTemplates(category?: string) {
  return useQuery({
    queryKey: [...TEMPLATES_KEY, category ?? "__all__"],
    queryFn: async (): Promise<AgentTemplateSummary[]> => {
      const res = await IpcClient.getInstance().listAgentTemplates(category);
      return res.templates;
    },
  });
}

export function useFeaturedAgentTemplates() {
  return useQuery({
    queryKey: FEATURED_KEY,
    queryFn: async (): Promise<AgentTemplateSummary[]> => {
      const res = await IpcClient.getInstance().listFeaturedAgentTemplates();
      return res.templates;
    },
  });
}

export function useCreateAgentFromTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: {
      templateId: string;
      name: string;
      description?: string;
    }) => {
      if (!args.templateId) throw new Error("templateId is required");
      if (!args.name?.trim()) throw new Error("name is required");
      const res = await IpcClient.getInstance().createAgentFromTemplate(args);
      return res.agent;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["agents"] });
      qc.invalidateQueries({ queryKey: ["agent-builder", "agents"] });
    },
  });
}

/**
 * One-shot featured task runner.
 *
 * Spins up a transient agent from a template, executes it once with the
 * supplied brief, returns the run output, and (optionally) discards the
 * agent. Used by the Featured Tasks page.
 */
export function useRunFeaturedTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: {
      templateId: string;
      brief: string;
      agentName?: string;
      keepAgent?: boolean;
    }) => {
      if (!args.templateId) throw new Error("templateId is required");
      if (!args.brief?.trim()) throw new Error("brief is required");
      const client = IpcClient.getInstance();
      const created = await client.createAgentFromTemplate({
        templateId: args.templateId,
        name: args.agentName?.trim() || `Task run · ${new Date().toLocaleString()}`,
      });
      const agentId = created.agent.id as string;
      try {
        const run = await client.executeAgent({
          agentId,
          input: args.brief,
        });
        return { agentId, agent: created.agent, run };
      } finally {
        if (!args.keepAgent) {
          try {
            await client.deleteAgent(agentId);
          } catch {
            // best effort cleanup
          }
        }
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["agents"] });
    },
  });
}
