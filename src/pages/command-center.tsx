/**
 * Unified Command Center page.
 *
 * Single dashboard that aggregates: active-agent counts, last-24h run
 * success / fail, token spend by model, upcoming scheduled jobs, and MCP
 * server / call counts. Data comes from one IPC call
 * (`command-center:get-overview`) and auto-refreshes every 30s.
 *
 * `/admin` and `/benchmark` are kept for deep dives — this page is the
 * "first look in the morning" surface.
 */

import { useNavigate } from "@tanstack/react-router";
import {
  Bot,
  Activity,
  Coins,
  Clock,
  Plug,
  RefreshCw,
  AlertCircle,
  CheckCircle2,
  Loader2,
} from "lucide-react";
import { useMemo } from "react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useCommandCenterOverview } from "@/hooks/useCommandCenterOverview";

function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

function formatRelative(ms: number | null): string {
  if (!ms) return "—";
  const diff = ms - Date.now();
  const abs = Math.abs(diff);
  const mins = Math.round(abs / 60_000);
  if (mins < 1) return diff >= 0 ? "in <1 min" : "just now";
  if (mins < 60) return diff >= 0 ? `in ${mins}m` : `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return diff >= 0 ? `in ${hrs}h` : `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return diff >= 0 ? `in ${days}d` : `${days}d ago`;
}

export default function CommandCenterPage() {
  const navigate = useNavigate();
  const { data, isLoading, isFetching, error, refetch } =
    useCommandCenterOverview();

  const successPct = useMemo(() => {
    if (!data) return 0;
    return Math.round((data.runs24h.successRate || 0) * 100);
  }, [data]);

  return (
    <div className="flex flex-col h-full w-full overflow-hidden">
      <div className="flex items-center justify-between px-6 py-4 border-b">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Command Center
          </h1>
          <p className="text-sm text-muted-foreground">
            One-glance view of your agents, runs, spend, and schedules.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {isFetching && (
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => refetch()}
            disabled={isFetching}
          >
            <RefreshCw className="h-4 w-4 mr-2" />
            Refresh
          </Button>
        </div>
      </div>

      <ScrollArea className="flex-1">
        <div className="p-6 space-y-6">
          {error && (
            <Card className="border-destructive/50 bg-destructive/5">
              <CardContent className="pt-6 flex items-center gap-3">
                <AlertCircle className="h-5 w-5 text-destructive" />
                <div>
                  <p className="font-medium">Failed to load overview</p>
                  <p className="text-sm text-muted-foreground">
                    {error instanceof Error ? error.message : String(error)}
                  </p>
                </div>
              </CardContent>
            </Card>
          )}

          {isLoading && !data && (
            <div className="flex items-center justify-center py-24 text-muted-foreground">
              <Loader2 className="h-5 w-5 mr-2 animate-spin" />
              Loading overview…
            </div>
          )}

          {data && (
            <>
              {/* Top KPI strip */}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                <Card
                  className="cursor-pointer hover:bg-accent/50 transition"
                  onClick={() => navigate({ to: "/agents" })}
                >
                  <CardHeader className="pb-2 flex flex-row items-center justify-between">
                    <CardTitle className="text-sm font-medium">
                      Active Agents
                    </CardTitle>
                    <Bot className="h-4 w-4 text-violet-500" />
                  </CardHeader>
                  <CardContent>
                    <div className="text-3xl font-bold">
                      {data.agents.active}
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">
                      of {data.agents.total} total
                      {data.agents.draft > 0 && ` · ${data.agents.draft} draft`}
                    </p>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader className="pb-2 flex flex-row items-center justify-between">
                    <CardTitle className="text-sm font-medium">
                      24h Run Success
                    </CardTitle>
                    <Activity className="h-4 w-4 text-emerald-500" />
                  </CardHeader>
                  <CardContent>
                    <div className="text-3xl font-bold">{successPct}%</div>
                    <div className="text-xs text-muted-foreground mt-1 flex items-center gap-3">
                      <span className="flex items-center gap-1">
                        <CheckCircle2 className="h-3 w-3 text-emerald-500" />
                        {data.runs24h.success}
                      </span>
                      <span className="flex items-center gap-1">
                        <AlertCircle className="h-3 w-3 text-rose-500" />
                        {data.runs24h.failed}
                      </span>
                      <span className="text-muted-foreground/70">
                        ({data.runs24h.total} total)
                      </span>
                    </div>
                    <Progress value={successPct} className="mt-3 h-1.5" />
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader className="pb-2 flex flex-row items-center justify-between">
                    <CardTitle className="text-sm font-medium">
                      24h Tokens
                    </CardTitle>
                    <Coins className="h-4 w-4 text-amber-500" />
                  </CardHeader>
                  <CardContent>
                    <div className="text-3xl font-bold">
                      {formatNumber(
                        data.tokenSpend24h.totalInputTokens +
                          data.tokenSpend24h.totalOutputTokens,
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">
                      {formatNumber(data.tokenSpend24h.totalInputTokens)} in ·{" "}
                      {formatNumber(data.tokenSpend24h.totalOutputTokens)} out
                    </p>
                  </CardContent>
                </Card>

                <Card
                  className="cursor-pointer hover:bg-accent/50 transition"
                  onClick={() => navigate({ to: "/mcp-hub" })}
                >
                  <CardHeader className="pb-2 flex flex-row items-center justify-between">
                    <CardTitle className="text-sm font-medium">
                      MCP Servers
                    </CardTitle>
                    <Plug className="h-4 w-4 text-cyan-500" />
                  </CardHeader>
                  <CardContent>
                    <div className="text-3xl font-bold">
                      {data.mcp.enabledServers}
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">
                      of {data.mcp.serverCount} configured ·{" "}
                      {data.mcp.callCount24h} calls / 24h
                    </p>
                  </CardContent>
                </Card>
              </div>

              {/* Lower panels: token spend + scheduled jobs */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">
                      Token Spend by Model (24h)
                    </CardTitle>
                    <CardDescription>
                      Top 10 models by combined input + output tokens.
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    {data.tokenSpend24h.byModel.length === 0 ? (
                      <p className="text-sm text-muted-foreground py-8 text-center">
                        No usage recorded in the last 24h.
                      </p>
                    ) : (
                      <ul className="space-y-2">
                        {data.tokenSpend24h.byModel.map((m) => {
                          const total = m.inputTokens + m.outputTokens;
                          const grand =
                            data.tokenSpend24h.totalInputTokens +
                            data.tokenSpend24h.totalOutputTokens;
                          const pct =
                            grand > 0 ? Math.round((total / grand) * 100) : 0;
                          return (
                            <li key={m.modelId} className="space-y-1">
                              <div className="flex items-center justify-between text-sm">
                                <span className="font-mono truncate max-w-[60%]">
                                  {m.modelId}
                                </span>
                                <span className="text-muted-foreground">
                                  {formatNumber(total)} · {m.events} runs
                                </span>
                              </div>
                              <Progress value={pct} className="h-1" />
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle className="text-base flex items-center gap-2">
                      <Clock className="h-4 w-4" />
                      Upcoming Scheduled Jobs
                    </CardTitle>
                    <CardDescription>
                      {data.scheduledJobs.enabled} enabled of{" "}
                      {data.scheduledJobs.total} total.
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    {data.scheduledJobs.upcoming.length === 0 ? (
                      <p className="text-sm text-muted-foreground py-8 text-center">
                        No upcoming scheduled jobs.
                      </p>
                    ) : (
                      <ul className="divide-y">
                        {data.scheduledJobs.upcoming.map((s) => (
                          <li
                            key={s.id}
                            className="py-2 flex items-center justify-between gap-3"
                          >
                            <div className="min-w-0">
                              <p className="text-sm font-medium truncate">
                                {s.name}
                              </p>
                              <p className="text-xs font-mono text-muted-foreground truncate">
                                {s.cron}
                              </p>
                            </div>
                            <Badge variant="secondary" className="shrink-0">
                              {formatRelative(s.nextRunAt)}
                            </Badge>
                          </li>
                        ))}
                      </ul>
                    )}
                  </CardContent>
                </Card>
              </div>
            </>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
