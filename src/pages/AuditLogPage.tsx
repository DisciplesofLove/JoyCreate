/**
 * Audit Log Page — security and access trail
 *
 * Reads the real `jcn_audit_log` through the local `audit:*` channels.
 *
 * This page used to render eight hardcoded rows — "Login from new device,
 * Windows 11, Chrome 124, 192.168.1.50" — while a genuine audit trail sat
 * unread in the database beneath it, written by the auth gateway, the job
 * executor and the key manager. Its filters filtered fixtures and its Export
 * button raised a toast. For a security surface that is the worst kind of bug:
 * it does not fail, it reassures.
 *
 * The severity/category vocabulary the mockup invented does not exist in the
 * schema, so this filters on what is actually recorded — actor type and target
 * type — rather than keeping controls that could never match a real row.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import {
  Shield,
  Search,
  Download,
  User,
  Bot,
  Settings,
  Key,
  FileText,
  Database,
  Rocket,
  Package,
  Loader2,
  RefreshCw,
  Activity,
} from "lucide-react";

import { IpcClient } from "@/ipc/ipc_client";
import type { AuditRow, AuditStats } from "@/ipc/ipc_client";

type ActorType = "user" | "system" | "admin";
type TargetType = "publish" | "job" | "bundle" | "license" | "key" | "config";

const ACTOR_ICON: Record<ActorType, React.ReactNode> = {
  user: <User className="w-3.5 h-3.5" />,
  system: <Bot className="w-3.5 h-3.5" />,
  admin: <Shield className="w-3.5 h-3.5" />,
};

const ACTOR_COLOR: Record<ActorType, string> = {
  user: "text-blue-400",
  system: "text-slate-400",
  admin: "text-amber-400",
};

const TARGET_ICON: Record<string, React.ReactNode> = {
  publish: <Rocket className="w-3 h-3" />,
  job: <Activity className="w-3 h-3" />,
  bundle: <Package className="w-3 h-3" />,
  license: <FileText className="w-3 h-3" />,
  key: <Key className="w-3 h-3" />,
  config: <Settings className="w-3 h-3" />,
};

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Save exported text through the browser, so the user picks the destination. */
function saveText(filename: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export default function AuditLogPage() {
  const [search, setSearch] = useState("");
  const [actorFilter, setActorFilter] = useState<ActorType | "all">("all");
  const [targetFilter, setTargetFilter] = useState<TargetType | "all">("all");

  const [rows, setRows] = useState<AuditRow[]>([]);
  const [stats, setStats] = useState<AuditStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  const ipc = IpcClient.getInstance();

  const query = useMemo(
    () => ({
      search: search.trim() || undefined,
      actorType: actorFilter === "all" ? undefined : actorFilter,
      targetType: targetFilter === "all" ? undefined : targetFilter,
      limit: 500,
    }),
    [search, actorFilter, targetFilter],
  );

  const load = useCallback(async () => {
    setError(null);
    try {
      // Filtering happens in SQL rather than in the component. The trail grows
      // without bound, and a page that fetches everything to filter in memory
      // gets slower exactly as the log becomes worth reading.
      const [list, s] = await Promise.all([
        ipc.queryAuditLog(query),
        ipc.getAuditStats(),
      ]);
      setRows(list ?? []);
      setStats(s ?? null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [ipc, query]);

  useEffect(() => {
    // Debounced so typing in the search box does not fire a query per keystroke.
    const t = setTimeout(() => void load(), 200);
    return () => clearTimeout(t);
  }, [load]);

  const onExport = async (format: "csv" | "json") => {
    setExporting(true);
    try {
      // Exports the current filter, not the current page — what you are looking
      // at, not the 500 rows that happened to be fetched.
      const result = await ipc.exportAuditLog({ ...query, limit: 100000, format });
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:]/g, "-");
      saveText(
        `audit-log-${stamp}.${format}`,
        result.content,
        format === "csv" ? "text/csv" : "application/json",
      );
      toast.success(`Exported ${result.rowCount} rows`);
    } catch (err) {
      toast.error(`Export failed: ${errorMessage(err)}`);
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="h-full flex flex-col">
      <div className="border-b p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-red-500 to-orange-600 flex items-center justify-center">
              <Shield className="w-5 h-5 text-white" />
            </div>
            <div>
              <h1 className="text-xl font-semibold">Audit Log</h1>
              <p className="text-sm text-muted-foreground">
                {loading
                  ? "Loading…"
                  : stats
                    ? `${rows.length} shown of ${stats.total} recorded`
                    : `${rows.length} events`}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void load()}
              disabled={loading}
            >
              <RefreshCw className="w-3.5 h-3.5 mr-1" /> Refresh
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={exporting || rows.length === 0}
              onClick={() => void onExport("csv")}
            >
              {exporting ? (
                <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />
              ) : (
                <Download className="w-3.5 h-3.5 mr-1" />
              )}
              Export CSV
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={exporting || rows.length === 0}
              onClick={() => void onExport("json")}
            >
              <Download className="w-3.5 h-3.5 mr-1" /> JSON
            </Button>
          </div>
        </div>
      </div>

      {/* Filters — actor and target, because that is what the schema records. */}
      <div className="flex items-center gap-2 p-3 border-b">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground/50" />
          <Input
            placeholder="Search action, actor or target…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-10 h-8 text-xs"
          />
        </div>
        <Select
          value={actorFilter}
          onValueChange={(v) => setActorFilter(v as ActorType | "all")}
        >
          <SelectTrigger className="w-[130px] h-8 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All actors</SelectItem>
            <SelectItem value="user">User</SelectItem>
            <SelectItem value="system">System</SelectItem>
            <SelectItem value="admin">Admin</SelectItem>
          </SelectContent>
        </Select>
        <Select
          value={targetFilter}
          onValueChange={(v) => setTargetFilter(v as TargetType | "all")}
        >
          <SelectTrigger className="w-[140px] h-8 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All targets</SelectItem>
            <SelectItem value="publish">Publish</SelectItem>
            <SelectItem value="job">Job</SelectItem>
            <SelectItem value="bundle">Bundle</SelectItem>
            <SelectItem value="license">License</SelectItem>
            <SelectItem value="key">Key</SelectItem>
            <SelectItem value="config">Config</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <ScrollArea className="flex-1 p-3">
        {loading ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground py-6">
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> Reading audit trail…
          </div>
        ) : error ? (
          <Card className="bg-red-500/5 border-red-500/20">
            <CardContent className="p-4 space-y-2">
              <p className="text-sm text-red-400">Could not read the audit log</p>
              <p className="text-xs font-mono text-muted-foreground">{error}</p>
              <Button size="sm" variant="outline" onClick={() => void load()}>
                <RefreshCw className="w-3.5 h-3.5 mr-1" /> Retry
              </Button>
            </CardContent>
          </Card>
        ) : rows.length === 0 ? (
          <Card className="bg-muted/10 border-border/30">
            <CardContent className="p-6 text-center space-y-1">
              <Database className="w-6 h-6 mx-auto text-muted-foreground/40" />
              <p className="text-sm">
                {stats?.total
                  ? "No events match these filters"
                  : "No audit events recorded yet"}
              </p>
              <p className="text-xs text-muted-foreground">
                {stats?.total
                  ? "Try widening the search or clearing a filter."
                  : "Publishing, key rotation and job execution write here as they happen."}
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-1.5">
            {rows.map((entry) => {
              const actor = (entry.actorType ?? "system") as ActorType;
              return (
                <Card key={entry.id} className="bg-muted/10 border-border/30">
                  <CardContent className="p-2.5 flex items-center gap-3">
                    <div
                      className={`w-8 h-8 rounded-lg bg-muted/30 flex items-center justify-center shrink-0 ${ACTOR_COLOR[actor] ?? ""}`}
                    >
                      {ACTOR_ICON[actor] ?? <Bot className="w-3.5 h-3.5" />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium">{entry.action}</span>
                        <Badge variant="outline" className="text-[9px] gap-0.5">
                          {TARGET_ICON[entry.targetType] ?? null}
                          {entry.targetType}
                        </Badge>
                      </div>
                      <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                        <span className="text-[10px] text-muted-foreground/60">
                          {new Date(entry.timestamp).toLocaleString()}
                        </span>
                        <span className="text-[10px] text-muted-foreground/40">•</span>
                        <span className="text-[10px] text-muted-foreground/60 font-mono truncate max-w-[200px]">
                          {entry.actorId || actor}
                        </span>
                        <span className="text-[10px] text-muted-foreground/40">•</span>
                        <span className="text-[10px] text-muted-foreground/50 font-mono truncate max-w-[240px]">
                          {entry.targetId}
                        </span>
                        {entry.actorWallet && (
                          <span className="text-[10px] text-muted-foreground/40 font-mono">
                            {entry.actorWallet.slice(0, 10)}…
                          </span>
                        )}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}
