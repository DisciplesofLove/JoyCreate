/**
 * WhitehatMcpPanel — embeddable tab content for the MCP Hub page.
 *
 * Three sub-tabs: Allowlist (manage), Audit (log), Setup (Claude Desktop
 * config recipe). Lives under the MCP Hub's "Whitehat" tab.
 */

import { useMemo, useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  useWhitehatMcpAllowlist,
  useWhitehatMcpAudit,
} from "@/hooks/useWhitehatMcp";
import { Trash2, Copy, RefreshCw } from "lucide-react";
import { toast } from "sonner";

const decisionTone: Record<string, string> = {
  allow: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  approved: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  deny: "bg-rose-500/15 text-rose-700 dark:text-rose-400",
  pending: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  revoked: "bg-zinc-500/15 text-zinc-700 dark:text-zinc-300",
};

function shortHash(h: string): string {
  return `${h.slice(0, 8)}…${h.slice(-6)}`;
}

function formatTs(secOrMs: number | null | undefined): string {
  if (!secOrMs) return "—";
  const ms = secOrMs < 1e12 ? secOrMs * 1000 : secOrMs;
  return new Date(ms).toLocaleString();
}

export function WhitehatMcpPanel() {
  return (
    <div className="space-y-4">
      <div className="rounded-md border bg-emerald-500/5 px-4 py-3 text-sm">
        Every Claude Desktop tool call is hashed against the Sovereign
        Blueprint before it touches the metal. Approve once and the hash
        becomes part of your trust manifest.
      </div>

      <Tabs defaultValue="allowlist">
        <TabsList>
          <TabsTrigger value="allowlist">Allowlist</TabsTrigger>
          <TabsTrigger value="audit">Audit log</TabsTrigger>
          <TabsTrigger value="setup">Claude Desktop setup</TabsTrigger>
        </TabsList>

        <TabsContent value="allowlist" className="mt-4">
          <AllowlistTab />
        </TabsContent>
        <TabsContent value="audit" className="mt-4">
          <AuditTab />
        </TabsContent>
        <TabsContent value="setup" className="mt-4">
          <SetupTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function AllowlistTab() {
  const { list, revoke } = useWhitehatMcpAllowlist();
  const rows = list.data ?? [];
  return (
    <div className="border rounded-lg overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2 bg-muted/40 border-b">
        <div className="text-sm font-medium">
          {rows.length} approved invocation{rows.length === 1 ? "" : "s"}
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => list.refetch()}
          disabled={list.isFetching}
        >
          <RefreshCw className="size-3.5 mr-1.5" />
          Refresh
        </Button>
      </div>
      {rows.length === 0 ? (
        <div className="p-6 text-sm text-muted-foreground text-center">
          No approved tool calls yet. Approvals appear here after you click
          “Allow always” in the Whitehat dialog.
        </div>
      ) : (
        <table className="w-full text-sm">
          <thead className="bg-muted/30 text-xs uppercase text-muted-foreground">
            <tr>
              <th className="text-left px-3 py-2">Server</th>
              <th className="text-left px-3 py-2">Tool</th>
              <th className="text-left px-3 py-2">Hash</th>
              <th className="text-left px-3 py-2">Scope</th>
              <th className="text-left px-3 py-2">Approved</th>
              <th className="text-left px-3 py-2">Last used</th>
              <th className="text-right px-3 py-2"> </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t hover:bg-muted/30">
                <td className="px-3 py-2 font-mono text-xs">{r.serverName}</td>
                <td className="px-3 py-2 font-mono text-xs">{r.toolName}</td>
                <td className="px-3 py-2 font-mono text-[10px]">
                  {shortHash(r.invocationHash)}
                </td>
                <td className="px-3 py-2">
                  <Badge variant="outline">{r.scope}</Badge>
                </td>
                <td className="px-3 py-2 text-xs">{formatTs(r.createdAt)}</td>
                <td className="px-3 py-2 text-xs">{formatTs(r.lastUsedAt)}</td>
                <td className="px-3 py-2 text-right">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={revoke.isPending}
                    onClick={() => {
                      revoke.mutate(r.id, {
                        onSuccess: () => toast.success("Revoked"),
                        onError: (e) => toast.error((e as Error).message),
                      });
                    }}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function AuditTab() {
  const [limit, setLimit] = useState(100);
  const audit = useWhitehatMcpAudit(limit);
  const rows = audit.data ?? [];
  return (
    <div className="border rounded-lg overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2 bg-muted/40 border-b">
        <div className="text-sm font-medium">
          Last {rows.length} decision{rows.length === 1 ? "" : "s"}
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setLimit((n) => n + 100)}
          >
            Load 100 more
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => audit.refetch()}
            disabled={audit.isFetching}
          >
            <RefreshCw className="size-3.5 mr-1.5" />
            Refresh
          </Button>
        </div>
      </div>
      {rows.length === 0 ? (
        <div className="p-6 text-sm text-muted-foreground text-center">
          No audit events recorded yet.
        </div>
      ) : (
        <table className="w-full text-sm">
          <thead className="bg-muted/30 text-xs uppercase text-muted-foreground">
            <tr>
              <th className="text-left px-3 py-2">When</th>
              <th className="text-left px-3 py-2">Decision</th>
              <th className="text-left px-3 py-2">Server</th>
              <th className="text-left px-3 py-2">Tool</th>
              <th className="text-left px-3 py-2">Hash</th>
              <th className="text-left px-3 py-2">Reason</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t hover:bg-muted/30">
                <td className="px-3 py-2 text-xs whitespace-nowrap">
                  {formatTs(r.createdAt)}
                </td>
                <td className="px-3 py-2">
                  <span
                    className={`px-2 py-0.5 rounded text-xs font-medium ${
                      decisionTone[r.decision] ?? ""
                    }`}
                  >
                    {r.decision}
                  </span>
                </td>
                <td className="px-3 py-2 font-mono text-xs">{r.serverName}</td>
                <td className="px-3 py-2 font-mono text-xs">{r.toolName}</td>
                <td className="px-3 py-2 font-mono text-[10px]">
                  {shortHash(r.invocationHash)}
                </td>
                <td className="px-3 py-2 text-xs text-muted-foreground">
                  {r.reason ?? "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function SetupTab() {
  const sandboxBin = useMemo(
    () => "<JoyCreate-install>/bin/joy-mcp-sandbox.mjs",
    [],
  );
  const example = JSON.stringify(
    {
      mcpServers: {
        filesystem: {
          command: "node",
          args: [
            sandboxBin,
            "--server",
            "filesystem",
            "--",
            "npx",
            "-y",
            "@modelcontextprotocol/server-filesystem",
            "C:/some/dir",
          ],
        },
      },
    },
    null,
    2,
  );
  return (
    <div className="space-y-4 max-w-3xl">
      <p className="text-sm text-muted-foreground">
        Edit{" "}
        <code className="text-xs bg-muted px-1.5 py-0.5 rounded">
          %APPDATA%/Claude/claude_desktop_config.json
        </code>{" "}
        and wrap each MCP server through the Whitehat sandbox shim:
      </p>
      <div className="relative">
        <pre className="text-xs bg-muted p-3 rounded overflow-auto">
          {example}
        </pre>
        <Button
          variant="ghost"
          size="sm"
          className="absolute top-2 right-2"
          onClick={() => {
            navigator.clipboard.writeText(example);
            toast.success("Copied");
          }}
        >
          <Copy className="size-3.5" />
        </Button>
      </div>
      <ul className="text-sm space-y-1 list-disc pl-5">
        <li>
          <strong>--server &lt;name&gt;</strong> is the logical name policy
          decisions are recorded under.
        </li>
        <li>
          Everything after <code>--</code> is the real MCP server command.
        </li>
        <li>
          First call to any tool prompts you in JoyCreate; pre-approve via the
          Allowlist tab to silence the dialog.
        </li>
      </ul>
    </div>
  );
}
