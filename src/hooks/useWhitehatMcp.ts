/**
 * useWhitehatMcp — TanStack Query bindings for the Whitehat MCP sandbox.
 *
 * Subscribes to the live `whitehat:mcp:pending` event, exposes the audit log
 * and allowlist as queries, and surfaces respond/revoke as guarded mutations.
 */

import { useEffect, useState } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  IpcClient,
  type WhitehatMcpAllowlistRow,
  type WhitehatMcpAuditRow,
  type WhitehatMcpPendingEntry,
} from "@/ipc/ipc_client";

const PENDING_KEY = ["whitehat-mcp", "pending"] as const;
const ALLOWLIST_KEY = ["whitehat-mcp", "allowlist"] as const;
const AUDIT_KEY = ["whitehat-mcp", "audit"] as const;

export function useWhitehatMcpPending() {
  const qc = useQueryClient();
  const [live, setLive] = useState<WhitehatMcpPendingEntry[]>([]);

  const initial = useQuery({
    queryKey: PENDING_KEY,
    queryFn: () => IpcClient.getInstance().listWhitehatMcpPending(),
  });

  useEffect(() => {
    if (initial.data) setLive(initial.data);
  }, [initial.data]);

  useEffect(() => {
    const unsub = IpcClient.getInstance().onWhitehatMcpPending((entry) => {
      setLive((prev) =>
        prev.some((p) => p.id === entry.id) ? prev : [...prev, entry],
      );
    });
    return unsub;
  }, []);

  const respond = useMutation({
    mutationFn: ({
      id,
      choice,
    }: {
      id: number;
      choice: "once" | "always" | "deny";
    }) => IpcClient.getInstance().respondWhitehatMcp(id, choice),
    onSuccess: (_data, vars) => {
      setLive((prev) => prev.filter((p) => p.id !== vars.id));
      qc.invalidateQueries({ queryKey: ALLOWLIST_KEY });
      qc.invalidateQueries({ queryKey: AUDIT_KEY });
      qc.invalidateQueries({ queryKey: PENDING_KEY });
    },
  });

  return { pending: live, respond };
}

export function useWhitehatMcpAllowlist() {
  const qc = useQueryClient();
  const list = useQuery<WhitehatMcpAllowlistRow[]>({
    queryKey: ALLOWLIST_KEY,
    queryFn: () => IpcClient.getInstance().listWhitehatMcpAllowlist(),
  });
  const revoke = useMutation({
    mutationFn: (id: number) => IpcClient.getInstance().revokeWhitehatMcp(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ALLOWLIST_KEY });
      qc.invalidateQueries({ queryKey: AUDIT_KEY });
    },
  });
  return { list, revoke };
}

export function useWhitehatMcpAudit(limit = 100) {
  return useQuery<WhitehatMcpAuditRow[]>({
    queryKey: [...AUDIT_KEY, limit],
    queryFn: () => IpcClient.getInstance().listWhitehatMcpAudit(limit),
  });
}
