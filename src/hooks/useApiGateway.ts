/**
 * TanStack Query hooks for the API Gateway IPC channels.
 *
 * Reads → useQuery, writes → useMutation with invalidation. Toasts on
 * success / error so the page stays simple.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  IpcClient,
  type ApiEndpointDetail,
  type ApiEndpointRow,
  type ApiGatewayCreateEndpointArgs,
  type ApiGatewayCreateKeyArgs,
  type ApiGatewayCreateKeyResult,
  type ApiGatewayStatus,
  type ApiGatewayUpdateEndpointArgs,
  type ApiKeyRow,
  type ApiUsageRow,
} from "@/ipc/ipc_client";

const ipc = IpcClient.getInstance();

const KEYS = {
  status: ["api-gateway", "status"] as const,
  endpoints: ["api-gateway", "endpoints"] as const,
  endpoint: (id: number) => ["api-gateway", "endpoint", id] as const,
  keys: (endpointId: number) => ["api-gateway", "keys", endpointId] as const,
  usage: (endpointId: number) => ["api-gateway", "usage", endpointId] as const,
};

export function useApiGatewayStatus() {
  return useQuery<ApiGatewayStatus>({
    queryKey: KEYS.status,
    queryFn: () => ipc.apiGatewayStatus(),
    refetchInterval: 10_000,
  });
}

export function useStartApiGateway() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (port?: number) => ipc.apiGatewayStart(port ? { port } : undefined),
    onSuccess: (status) => {
      toast.success(
        status.baseUrl
          ? `API gateway running on ${status.baseUrl}`
          : "API gateway started",
      );
      qc.invalidateQueries({ queryKey: KEYS.status });
    },
    onError: (err: Error) => toast.error(`Start failed: ${err.message}`),
  });
}

export function useStopApiGateway() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => ipc.apiGatewayStop(),
    onSuccess: () => {
      toast.success("API gateway stopped");
      qc.invalidateQueries({ queryKey: KEYS.status });
    },
    onError: (err: Error) => toast.error(`Stop failed: ${err.message}`),
  });
}

export function useApiEndpoints() {
  return useQuery<ApiEndpointRow[]>({
    queryKey: KEYS.endpoints,
    queryFn: () => ipc.apiGatewayListEndpoints(),
  });
}

export function useApiEndpoint(id: number | null) {
  return useQuery<ApiEndpointDetail>({
    queryKey: id ? KEYS.endpoint(id) : ["api-gateway", "endpoint", "none"],
    queryFn: () => ipc.apiGatewayGetEndpoint({ id: id! }),
    enabled: id !== null,
    refetchInterval: id ? 15_000 : false,
  });
}

export function useCreateApiEndpoint() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: ApiGatewayCreateEndpointArgs) =>
      ipc.apiGatewayCreateEndpoint(args),
    onSuccess: (row) => {
      toast.success(`Created endpoint "${row.slug}"`);
      qc.invalidateQueries({ queryKey: KEYS.endpoints });
    },
    onError: (err: Error) => toast.error(`Create failed: ${err.message}`),
  });
}

export function useUpdateApiEndpoint() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: ApiGatewayUpdateEndpointArgs) =>
      ipc.apiGatewayUpdateEndpoint(args),
    onSuccess: (row) => {
      toast.success("Endpoint updated");
      qc.invalidateQueries({ queryKey: KEYS.endpoints });
      qc.invalidateQueries({ queryKey: KEYS.endpoint(row.id) });
    },
    onError: (err: Error) => toast.error(`Update failed: ${err.message}`),
  });
}

export function useDeleteApiEndpoint() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => ipc.apiGatewayDeleteEndpoint({ id }),
    onSuccess: () => {
      toast.success("Endpoint deleted");
      qc.invalidateQueries({ queryKey: KEYS.endpoints });
    },
    onError: (err: Error) => toast.error(`Delete failed: ${err.message}`),
  });
}

export function useApiKeys(endpointId: number | null) {
  return useQuery<ApiKeyRow[]>({
    queryKey: endpointId ? KEYS.keys(endpointId) : ["api-gateway", "keys", "none"],
    queryFn: () => ipc.apiGatewayListKeys({ endpointId: endpointId! }),
    enabled: endpointId !== null,
  });
}

export function useCreateApiKey() {
  const qc = useQueryClient();
  return useMutation<ApiGatewayCreateKeyResult, Error, ApiGatewayCreateKeyArgs>({
    mutationFn: (args) => ipc.apiGatewayCreateKey(args),
    onSuccess: (_res, args) => {
      toast.success("API key created — copy it now, it will not be shown again.");
      qc.invalidateQueries({ queryKey: KEYS.keys(args.endpointId) });
      qc.invalidateQueries({ queryKey: KEYS.endpoint(args.endpointId) });
    },
    onError: (err) => toast.error(`Create key failed: ${err.message}`),
  });
}

export function useRevokeApiKey(endpointId: number | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => ipc.apiGatewayRevokeKey({ id }),
    onSuccess: () => {
      toast.success("Key revoked");
      if (endpointId) qc.invalidateQueries({ queryKey: KEYS.keys(endpointId) });
    },
    onError: (err: Error) => toast.error(`Revoke failed: ${err.message}`),
  });
}

export function useApiUsage(endpointId: number | null, limit = 50) {
  return useQuery<ApiUsageRow[]>({
    queryKey: endpointId
      ? [...KEYS.usage(endpointId), limit]
      : ["api-gateway", "usage", "none"],
    queryFn: () => ipc.apiGatewayListUsage({ endpointId: endpointId!, limit }),
    enabled: endpointId !== null,
    refetchInterval: endpointId ? 15_000 : false,
  });
}
