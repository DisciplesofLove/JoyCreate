/**
 * Browser Plugin React Hooks — TanStack Query wrappers.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { browserPluginClient } from "../ipc/clients/browser_plugin_client";
import type {
  BrowserPlugin,
  BuildBrowserPluginRequest,
  CreateBrowserPluginRequest,
  UpdateBrowserPluginRequest,
} from "../types/browser_plugin";

export const browserPluginKeys = {
  all: ["browser-plugins"] as const,
  list: () => [...browserPluginKeys.all, "list"] as const,
};

export function useBrowserPlugins() {
  return useQuery<BrowserPlugin[]>({
    queryKey: browserPluginKeys.list(),
    queryFn: () => browserPluginClient.list(),
    staleTime: 30_000,
  });
}

export function useSaveBrowserPlugin() {
  const qc = useQueryClient();
  return useMutation<
    BrowserPlugin,
    Error,
    CreateBrowserPluginRequest | UpdateBrowserPluginRequest
  >({
    mutationFn: (params) => browserPluginClient.save(params),
    onSuccess: (plugin) => {
      qc.invalidateQueries({ queryKey: browserPluginKeys.list() });
      toast.success(`Saved "${plugin.name}"`);
    },
    onError: (err) => toast.error(`Failed to save plugin: ${err.message}`),
  });
}

export function useDeleteBrowserPlugin() {
  const qc = useQueryClient();
  return useMutation<{ ok: true }, Error, string>({
    mutationFn: (id) => browserPluginClient.remove(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: browserPluginKeys.list() });
      toast.success("Plugin removed");
    },
    onError: (err) => toast.error(`Failed to remove plugin: ${err.message}`),
  });
}

export function useToggleBrowserPlugin() {
  const qc = useQueryClient();
  return useMutation<
    BrowserPlugin,
    Error,
    { id: string; enabled: boolean }
  >({
    mutationFn: ({ id, enabled }) => browserPluginClient.toggle(id, enabled),
    onSuccess: (p) => {
      qc.invalidateQueries({ queryKey: browserPluginKeys.list() });
      toast.success(p.enabled ? `Enabled "${p.name}"` : `Disabled "${p.name}"`);
    },
    onError: (err) => toast.error(`Failed to toggle plugin: ${err.message}`),
  });
}

export function useBuildBrowserPlugin() {
  const qc = useQueryClient();
  return useMutation<BrowserPlugin, Error, BuildBrowserPluginRequest>({
    mutationFn: (params) => browserPluginClient.build(params),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: browserPluginKeys.list() });
    },
    onError: (err) => toast.error(`AI plugin builder failed: ${err.message}`),
  });
}
