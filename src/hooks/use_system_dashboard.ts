/**
 * System Dashboard hooks (TanStack Query).
 *
 * Live data sources for the Agentic OS Dashboard and Integrations Hub:
 * - External service status (n8n, Celestia, Ollama, Radicle)
 * - Agent fleet (agent-builder)
 * - OpenClaw gateway status, providers, and cost summary
 * - n8n workflows
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { IpcClient } from "@/ipc/ipc_client";
import { OpenClawClient } from "@/ipc/openclaw_client";
import { showError } from "@/lib/toast";

const REFRESH_MS = 15_000;

const handleError = (e: unknown) => {
  showError(e instanceof Error ? e : new Error(String(e)));
};

export const systemDashboardKeys = {
  all: ["system-dashboard"] as const,
  services: ["system-dashboard", "services"] as const,
  servicesList: ["system-dashboard", "services-list"] as const,
  agents: (status?: string) =>
    ["system-dashboard", "agents", status ?? "all"] as const,
  gateway: ["system-dashboard", "openclaw-gateway"] as const,
  providers: ["system-dashboard", "openclaw-providers"] as const,
  cost: ["system-dashboard", "openclaw-cost"] as const,
  workflows: ["system-dashboard", "n8n-workflows"] as const,
};

// ── External services ───────────────────────────────────────────────────────

export function useServicesStatus() {
  return useQuery({
    queryKey: systemDashboardKeys.services,
    queryFn: () => IpcClient.getInstance().getServicesStatus(),
    refetchInterval: REFRESH_MS,
  });
}

export function useServicesList() {
  return useQuery({
    queryKey: systemDashboardKeys.servicesList,
    queryFn: () => IpcClient.getInstance().listServices(),
    staleTime: Infinity,
  });
}

export function useStartService() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (serviceId: "n8n" | "celestia" | "ollama" | "radicle") =>
      IpcClient.getInstance().startService(serviceId),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: systemDashboardKeys.services }),
    onError: handleError,
  });
}

export function useStopService() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (serviceId: "n8n" | "celestia" | "ollama" | "radicle") =>
      IpcClient.getInstance().stopService(serviceId),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: systemDashboardKeys.services }),
    onError: handleError,
  });
}

export function useStartAllServices() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => IpcClient.getInstance().startAllServices(),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: systemDashboardKeys.services }),
    onError: handleError,
  });
}

export function useStopAllServices() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => IpcClient.getInstance().stopAllServices(),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: systemDashboardKeys.services }),
    onError: handleError,
  });
}

// ── Agent fleet ───────────────────────────────────────────────────────────

export function useBuilderAgents(args?: {
  status?: "draft" | "active" | "paused" | "archived";
  type?: string;
  tags?: string[];
  search?: string;
}) {
  return useQuery({
    queryKey: systemDashboardKeys.agents(args?.status),
    queryFn: async () => {
      const res = await IpcClient.getInstance().listBuilderAgents(args);
      return res.agents ?? [];
    },
    refetchInterval: REFRESH_MS,
  });
}

export function useSetAgentStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (params: {
      agentId: string;
      status: "draft" | "active" | "paused" | "archived";
    }) =>
      IpcClient.getInstance().updateBuilderAgent({
        agentId: params.agentId,
        updates: { status: params.status },
      }),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["system-dashboard", "agents"] }),
    onError: handleError,
  });
}

// ── OpenClaw gateway / providers / cost ─────────────────────────────────────

export function useOpenClawGatewayStatus() {
  return useQuery({
    queryKey: systemDashboardKeys.gateway,
    queryFn: () => OpenClawClient.getGatewayStatus(),
    refetchInterval: REFRESH_MS,
  });
}

export function useOpenClawProviders() {
  return useQuery({
    queryKey: systemDashboardKeys.providers,
    queryFn: () => OpenClawClient.listProviders(),
    refetchInterval: REFRESH_MS,
  });
}

export function useOpenClawCostSummary() {
  return useQuery({
    queryKey: systemDashboardKeys.cost,
    queryFn: () => OpenClawClient.getCostSummary(),
    refetchInterval: REFRESH_MS,
  });
}

// ── n8n workflows ───────────────────────────────────────────────────────────

export function useN8nWorkflows() {
  return useQuery({
    queryKey: systemDashboardKeys.workflows,
    queryFn: () => IpcClient.getInstance().listN8nWorkflows(),
    refetchInterval: REFRESH_MS,
  });
}
