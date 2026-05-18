/**
 * Hook for the built-in MCP tool catalog. Exposes the descriptor list
 * for use in pickers, catalog views, and the agent editor.
 */

import { useQuery } from "@tanstack/react-query";
import { IpcClient } from "@/ipc/ipc_client";

export interface BuiltinMcpToolDescriptor {
  id: string;
  name: string;
  description: string;
  category: string;
  inputSchema: {
    type: "object";
    properties: Record<
      string,
      { type: string; description?: string; default?: unknown }
    >;
    required?: string[];
  };
}

export function useBuiltinMcpTools() {
  return useQuery({
    queryKey: ["builtin-mcp-tools"],
    queryFn: async (): Promise<BuiltinMcpToolDescriptor[]> => {
      const res = await IpcClient.getInstance().listBuiltinMcpTools();
      return res.tools as BuiltinMcpToolDescriptor[];
    },
    staleTime: 5 * 60_000,
  });
}
