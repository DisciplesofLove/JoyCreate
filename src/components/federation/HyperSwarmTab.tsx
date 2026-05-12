/**
 * Hyper Swarm Tab — live view of the Hypercore (Holepunch) peer layer.
 *
 * Shown inside the Federation page; exposes start/stop, joined topics
 * (per-scope counts), live peer list, and per-topic stats backed by the
 * `hyper:*` IPC channels registered in
 * [src/ipc/handlers/hyper_handlers.ts](src/ipc/handlers/hyper_handlers.ts).
 */

import { useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Activity,
  Database,
  HardDrive,
  Loader2,
  Network,
  Pause,
  Play,
  RefreshCw,
  Server,
  Zap,
} from "lucide-react";
import { IpcClient } from "@/ipc/ipc_client";

const ipc = IpcClient.getInstance();

const HYPER_STATUS_KEY = ["hyper", "status"] as const;
const HYPER_TOPICS_KEY = ["hyper", "topics"] as const;
const HYPER_PEERS_KEY = ["hyper", "peers"] as const;

function shorten(hex: string | null | undefined, head = 8, tail = 6): string {
  if (!hex) return "—";
  if (hex.length <= head + tail + 1) return hex;
  return `${hex.slice(0, head)}…${hex.slice(-tail)}`;
}

function formatRelative(ts: number | null): string {
  if (!ts) return "—";
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  return `${Math.floor(diffSec / 86400)}d ago`;
}

export function HyperSwarmTab() {
  const qc = useQueryClient();

  const statusQuery = useQuery({
    queryKey: HYPER_STATUS_KEY,
    queryFn: () => ipc.hyperStatus(),
    refetchInterval: 4000,
  });

  const ready = statusQuery.data?.ready ?? false;

  const topicsQuery = useQuery({
    queryKey: HYPER_TOPICS_KEY,
    queryFn: () => ipc.hyperListTopics(),
    enabled: ready,
    refetchInterval: 5000,
  });

  const peersQuery = useQuery({
    queryKey: HYPER_PEERS_KEY,
    queryFn: () => ipc.hyperListPeers(),
    enabled: ready,
    refetchInterval: 4000,
  });

  const startMutation = useMutation({
    mutationFn: () => ipc.hyperStart(),
    onSuccess: () => {
      toast.success("Hyper swarm started");
      qc.invalidateQueries({ queryKey: ["hyper"] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : String(err)),
  });

  const stopMutation = useMutation({
    mutationFn: () => ipc.hyperStop(),
    onSuccess: () => {
      toast.success("Hyper swarm stopped");
      qc.invalidateQueries({ queryKey: ["hyper"] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : String(err)),
  });

  const topicsByScope = useMemo(() => {
    const map = new Map<string, number>();
    for (const t of topicsQuery.data ?? []) {
      map.set(t.scope, (map.get(t.scope) ?? 0) + 1);
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1]);
  }, [topicsQuery.data]);

  return (
    <div className="space-y-4">
      {/* Status / lifecycle controls */}
      <Card className="bg-muted/10 border-border/30">
        <CardHeader className="py-3 px-4 flex-row items-center justify-between">
          <CardTitle className="text-sm flex items-center gap-2">
            <Network className="w-4 h-4 text-blue-400" />
            Hypercore Swarm
            {ready ? (
              <Badge className="bg-green-500/20 text-green-400 text-[9px]">running</Badge>
            ) : (
              <Badge variant="outline" className="text-[9px]">stopped</Badge>
            )}
          </CardTitle>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-7"
              onClick={() => qc.invalidateQueries({ queryKey: ["hyper"] })}
              disabled={statusQuery.isFetching}
            >
              <RefreshCw className={`w-3.5 h-3.5 mr-1 ${statusQuery.isFetching ? "animate-spin" : ""}`} />
              Refresh
            </Button>
            {ready ? (
              <Button
                size="sm"
                variant="destructive"
                className="h-7"
                onClick={() => stopMutation.mutate()}
                disabled={stopMutation.isPending}
              >
                {stopMutation.isPending ? <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" /> : <Pause className="w-3.5 h-3.5 mr-1" />}
                Stop
              </Button>
            ) : (
              <Button
                size="sm"
                className="h-7"
                onClick={() => startMutation.mutate()}
                disabled={startMutation.isPending}
              >
                {startMutation.isPending ? <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" /> : <Play className="w-3.5 h-3.5 mr-1" />}
                Start
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="px-4 pb-4">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <StatTile
              icon={<Server className="w-4 h-4 text-blue-400" />}
              label="Connections"
              value={statusQuery.data?.swarmConnections ?? 0}
            />
            <StatTile
              icon={<Database className="w-4 h-4 text-violet-400" />}
              label="Topics"
              value={statusQuery.data?.topicsCount ?? 0}
            />
            <StatTile
              icon={<Activity className="w-4 h-4 text-emerald-400" />}
              label="Peers"
              value={peersQuery.data?.length ?? 0}
            />
            <StatTile
              icon={<Zap className="w-4 h-4 text-amber-400" />}
              label="Started"
              value={formatRelative(statusQuery.data?.startedAt ?? null)}
            />
          </div>
          <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-2 text-[10px] text-muted-foreground/60">
            <div>
              <span className="text-muted-foreground/40">Device key:</span>{" "}
              <span className="font-mono">{shorten(statusQuery.data?.deviceKeyHex, 12, 8)}</span>
            </div>
            <div>
              <span className="text-muted-foreground/40">Storage:</span>{" "}
              <span className="font-mono">{statusQuery.data?.rootDir ?? "—"}</span>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Topics per scope summary */}
      <Card className="bg-muted/10 border-border/30">
        <CardHeader className="py-3 px-4">
          <CardTitle className="text-sm flex items-center gap-2">
            <HardDrive className="w-4 h-4 text-violet-400" />
            Topics by Scope
          </CardTitle>
        </CardHeader>
        <CardContent className="px-4 pb-4">
          {!ready ? (
            <p className="text-xs text-muted-foreground/50">Start the swarm to see topics.</p>
          ) : topicsByScope.length === 0 ? (
            <p className="text-xs text-muted-foreground/50">No topics joined yet.</p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {topicsByScope.map(([scope, count]) => (
                <Badge key={scope} variant="outline" className="text-[10px]">
                  {scope} <span className="ml-1 text-muted-foreground/50">×{count}</span>
                </Badge>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Live peer list */}
      <Card className="bg-muted/10 border-border/30">
        <CardHeader className="py-3 px-4">
          <CardTitle className="text-sm flex items-center gap-2">
            <Server className="w-4 h-4 text-emerald-400" />
            Connected Peers
          </CardTitle>
        </CardHeader>
        <CardContent className="px-4 pb-4">
          {!ready ? (
            <p className="text-xs text-muted-foreground/50">Start the swarm to discover peers.</p>
          ) : (peersQuery.data?.length ?? 0) === 0 ? (
            <p className="text-xs text-muted-foreground/50">No peers connected yet.</p>
          ) : (
            <ScrollArea className="h-[180px] pr-2">
              <div className="space-y-1">
                {(peersQuery.data ?? []).map((p) => (
                  <div
                    key={p.publicKeyHex}
                    className="flex items-center justify-between text-[11px] py-1 border-b border-border/20"
                  >
                    <span className="font-mono">{shorten(p.publicKeyHex, 10, 8)}</span>
                    <span className="text-muted-foreground/50">
                      {p.topicsHex.length} topics · {formatRelative(p.lastSeenAt)}
                    </span>
                  </div>
                ))}
              </div>
            </ScrollArea>
          )}
        </CardContent>
      </Card>

      {/* Open topics detail */}
      <Card className="bg-muted/10 border-border/30">
        <CardHeader className="py-3 px-4">
          <CardTitle className="text-sm flex items-center gap-2">
            <Database className="w-4 h-4 text-blue-400" />
            Open Topics
          </CardTitle>
        </CardHeader>
        <CardContent className="px-4 pb-4">
          {!ready ? (
            <p className="text-xs text-muted-foreground/50">Start the swarm to see topics.</p>
          ) : (topicsQuery.data?.length ?? 0) === 0 ? (
            <p className="text-xs text-muted-foreground/50">No topics open.</p>
          ) : (
            <ScrollArea className="h-[220px] pr-2">
              <div className="space-y-1">
                {(topicsQuery.data ?? []).map((t) => (
                  <div
                    key={t.discoveryKeyHex}
                    className="flex items-center gap-2 text-[11px] py-1 border-b border-border/20"
                  >
                    <Badge variant="outline" className="text-[9px] uppercase">{t.type}</Badge>
                    <span className="text-muted-foreground/80 font-mono truncate flex-1">
                      {t.scope}/{t.subjectId}
                    </span>
                    <span className="text-muted-foreground/50">len {t.length}</span>
                    <span className="font-mono text-muted-foreground/40">{shorten(t.discoveryKeyHex, 6, 6)}</span>
                  </div>
                ))}
              </div>
            </ScrollArea>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function StatTile({ icon, label, value }: { icon: React.ReactNode; label: string; value: string | number }) {
  return (
    <div className="flex items-center gap-2 p-2 rounded-md bg-background/40">
      {icon}
      <div className="flex flex-col">
        <span className="text-[9px] uppercase tracking-wide text-muted-foreground/50">{label}</span>
        <span className="text-sm font-medium">{value}</span>
      </div>
    </div>
  );
}
