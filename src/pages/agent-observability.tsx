/**
 * Agent Observability page.
 *
 * Aggregates execution data from the in-memory `executions` map plus
 * schedule history into a single dashboard so the operator can see
 * per-agent run counts, success rate, latency, and token usage at a glance.
 */

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  CheckCircle2,
  AlertCircle,
  Clock,
  Cpu,
  Loader2,
  TrendingUp,
  Brain,
  Wrench,
  Eye,
  MessageSquare,
} from "lucide-react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

import { IpcClient } from "@/ipc/ipc_client";
import { agentBuilderClient } from "@/ipc/agent_builder_client";
import {
  useAgentSchedules,
  useAgentScheduleHistory,
} from "@/hooks/useAgentSchedules";

interface ExecutionStepLike {
  id: string;
  type: "thought" | "tool_call" | "observation" | "response";
  content: string;
  toolName?: string;
  toolInput?: any;
  toolOutput?: any;
  timestamp: string | Date;
  duration?: number;
}

interface ExecutionLike {
  id: string;
  agentId: string;
  status: "running" | "completed" | "failed" | "cancelled";
  startedAt: string | Date;
  completedAt?: string | Date;
  input?: any;
  output?: any;
  error?: string;
  source?:
    | "manual"
    | "schedule"
    | "joy-assistant"
    | "openclaw"
    | "cns"
    | "orchestrator"
    | "template";
  steps?: ExecutionStepLike[];
  metrics?: {
    totalDuration?: number;
    tokensUsed?: { input?: number; output?: number; total?: number };
    toolCallCount?: number;
    iterationCount?: number;
  };
}

function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;}

function sourceBadgeClass(source: NonNullable<ExecutionLike["source"]>): string {
  switch (source) {
    case "joy-assistant":
      return "bg-violet-500/15 text-violet-700 dark:text-violet-300";
    case "openclaw":
      return "bg-orange-500/15 text-orange-700 dark:text-orange-300";
    case "cns":
      return "bg-cyan-500/15 text-cyan-700 dark:text-cyan-300";
    case "schedule":
      return "bg-blue-500/15 text-blue-700 dark:text-blue-300";
    case "orchestrator":
      return "bg-fuchsia-500/15 text-fuchsia-700 dark:text-fuchsia-300";
    case "template":
      return "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300";
    case "manual":
    default:
      return "bg-muted text-muted-foreground";
  }
}

function stepIcon(type: ExecutionStepLike["type"]) {
  switch (type) {
    case "thought":
      return <Brain className="h-3.5 w-3.5 text-violet-500" />;
    case "tool_call":
      return <Wrench className="h-3.5 w-3.5 text-amber-500" />;
    case "observation":
      return <Eye className="h-3.5 w-3.5 text-sky-500" />;
    case "response":
      return <MessageSquare className="h-3.5 w-3.5 text-emerald-500" />;
  }
}

function pretty(value: unknown): string {
  if (value === undefined || value === null) return "—";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export default function AgentObservabilityPage() {
  const agentsQuery = useQuery({
    queryKey: ["agents"],
    queryFn: () => agentBuilderClient.listAgents(),
  });

  const executionsQuery = useQuery({
    queryKey: ["agent-executions", "all"],
    queryFn: async (): Promise<ExecutionLike[]> => {
      const res = await IpcClient.getInstance().listAgentExecutions({
        limit: 500,
      });
      return res.executions;
    },
    refetchInterval: 15_000,
  });

  const schedulesQuery = useAgentSchedules();
  const scheduleHistoryQuery = useAgentScheduleHistory(undefined, 200);

  const agents = agentsQuery.data ?? [];
  const executions = executionsQuery.data ?? [];
  const schedules = schedulesQuery.data ?? [];
  const scheduleHistory = scheduleHistoryQuery.data ?? [];

  const agentNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of agents) m.set(a.id, a.name);
    return m;
  }, [agents]);

  const stats = useMemo(() => {
    const total = executions.length;
    const completed = executions.filter((e) => e.status === "completed").length;
    const failed = executions.filter((e) => e.status === "failed").length;
    const running = executions.filter((e) => e.status === "running").length;
    const successRate = total > 0 ? (completed / total) * 100 : 0;

    let totalDuration = 0;
    let totalTokens = 0;
    let withDuration = 0;
    for (const e of executions) {
      const d = e.metrics?.totalDuration ?? 0;
      if (d > 0) {
        totalDuration += d;
        withDuration++;
      }
      totalTokens += e.metrics?.tokensUsed?.total ?? 0;
    }
    const avgDuration = withDuration > 0 ? totalDuration / withDuration : 0;
    const avgTokens = total > 0 ? totalTokens / total : 0;

    return {
      total,
      completed,
      failed,
      running,
      successRate,
      avgDuration,
      avgTokens,
      totalTokens,
    };
  }, [executions]);

  const perAgent = useMemo(() => {
    const map = new Map<
      string,
      {
        agentId: string;
        runs: number;
        completed: number;
        failed: number;
        totalTokens: number;
        totalDuration: number;
        durationCount: number;
      }
    >();
    for (const e of executions) {
      const cur = map.get(e.agentId) ?? {
        agentId: e.agentId,
        runs: 0,
        completed: 0,
        failed: 0,
        totalTokens: 0,
        totalDuration: 0,
        durationCount: 0,
      };
      cur.runs++;
      if (e.status === "completed") cur.completed++;
      if (e.status === "failed") cur.failed++;
      cur.totalTokens += e.metrics?.tokensUsed?.total ?? 0;
      const d = e.metrics?.totalDuration ?? 0;
      if (d > 0) {
        cur.totalDuration += d;
        cur.durationCount++;
      }
      map.set(e.agentId, cur);
    }
    return Array.from(map.values()).sort((a, b) => b.runs - a.runs);
  }, [executions]);

  const recent = executions.slice(0, 25);
  const recentScheduleRuns = scheduleHistory.slice(0, 25);

  const [selectedExecutionId, setSelectedExecutionId] = useState<string | null>(
    null,
  );
  const selectedExecution = useMemo(
    () => executions.find((e) => e.id === selectedExecutionId) ?? null,
    [executions, selectedExecutionId],
  );

  return (
    <div className="container mx-auto p-6 space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
          <Activity className="h-7 w-7 text-sky-500" />
          Agent Observability
        </h1>
        <p className="text-muted-foreground mt-1">
          Per-agent runs, success rate, latency, tokens, and schedule activity.
        </p>
      </div>

      {/* Global KPIs */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Total runs</CardDescription>
            <CardTitle className="text-3xl">{stats.total}</CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            {stats.running > 0 && (
              <Badge variant="outline" className="mr-1">
                {stats.running} running
              </Badge>
            )}
            <span>{stats.completed} ok · {stats.failed} failed</span>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Success rate</CardDescription>
            <CardTitle className="text-3xl flex items-center gap-2">
              {stats.successRate.toFixed(1)}%
              <TrendingUp className="h-5 w-5 text-emerald-500" />
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Avg latency</CardDescription>
            <CardTitle className="text-3xl flex items-center gap-2">
              {formatMs(stats.avgDuration)}
              <Clock className="h-5 w-5 text-amber-500" />
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Total tokens</CardDescription>
            <CardTitle className="text-3xl flex items-center gap-2">
              {stats.totalTokens.toLocaleString()}
              <Cpu className="h-5 w-5 text-violet-500" />
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            avg {Math.round(stats.avgTokens)} / run
          </CardContent>
        </Card>
      </div>

      {/* Schedule snapshot */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Schedules</CardTitle>
          <CardDescription>
            {schedules.length} configured · {schedules.filter((s) => s.enabled).length} active
          </CardDescription>
        </CardHeader>
      </Card>

      {/* Per-agent table */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Per-agent metrics</CardTitle>
        </CardHeader>
        <CardContent>
          {executionsQuery.isLoading ? (
            <div className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading...
            </div>
          ) : perAgent.length === 0 ? (
            <p className="text-sm text-muted-foreground">No runs yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-muted-foreground border-b">
                    <th className="py-2 pr-4">Agent</th>
                    <th className="py-2 pr-4">Runs</th>
                    <th className="py-2 pr-4">Ok</th>
                    <th className="py-2 pr-4">Failed</th>
                    <th className="py-2 pr-4">Success</th>
                    <th className="py-2 pr-4">Avg latency</th>
                    <th className="py-2 pr-4">Tokens</th>
                  </tr>
                </thead>
                <tbody>
                  {perAgent.map((row) => {
                    const successRate =
                      row.runs > 0 ? (row.completed / row.runs) * 100 : 0;
                    const avgDur =
                      row.durationCount > 0
                        ? row.totalDuration / row.durationCount
                        : 0;
                    return (
                      <tr key={row.agentId} className="border-b last:border-0">
                        <td className="py-2 pr-4 font-medium">
                          {agentNameById.get(row.agentId) ?? row.agentId}
                        </td>
                        <td className="py-2 pr-4">{row.runs}</td>
                        <td className="py-2 pr-4 text-emerald-600">
                          {row.completed}
                        </td>
                        <td className="py-2 pr-4 text-rose-600">
                          {row.failed}
                        </td>
                        <td className="py-2 pr-4">{successRate.toFixed(1)}%</td>
                        <td className="py-2 pr-4">{formatMs(avgDur)}</td>
                        <td className="py-2 pr-4">
                          {row.totalTokens.toLocaleString()}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Recent runs */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Recent executions</CardTitle>
          </CardHeader>
          <CardContent>
            <ScrollArea className="max-h-96">
              {recent.length === 0 ? (
                <p className="text-sm text-muted-foreground">No runs yet.</p>
              ) : (
                <div className="divide-y">
                  {recent.map((e) => (
                    <button
                      key={e.id}
                      type="button"
                      onClick={() => setSelectedExecutionId(e.id)}
                      className="block w-full text-left py-2 text-sm hover:bg-muted/40 rounded px-2 -mx-2 transition-colors"
                    >
                      <div className="flex items-center gap-2">
                        {e.status === "completed" ? (
                          <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
                        ) : e.status === "failed" ? (
                          <AlertCircle className="h-3.5 w-3.5 text-rose-500" />
                        ) : (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        )}
                        <span className="font-medium truncate">
                          {agentNameById.get(e.agentId) ?? e.agentId}
                        </span>
                        <Badge variant="outline" className="ml-auto text-[10px]">
                          {new Date(e.startedAt).toLocaleString()}
                        </Badge>
                      </div>
                      <div className="text-xs text-muted-foreground flex gap-3 pl-5">
                        <span>
                          {formatMs(e.metrics?.totalDuration ?? 0)}
                        </span>
                        <span>
                          {e.metrics?.tokensUsed?.total ?? 0} tok
                        </span>
                        <span>
                          {e.metrics?.toolCallCount ?? 0} tool calls
                        </span>
                        {(e.steps?.length ?? 0) > 0 && (
                          <span>{e.steps?.length} steps</span>
                        )}
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </ScrollArea>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Recent scheduled runs</CardTitle>
          </CardHeader>
          <CardContent>
            <ScrollArea className="max-h-96">
              {recentScheduleRuns.length === 0 ? (
                <p className="text-sm text-muted-foreground">No scheduled runs yet.</p>
              ) : (
                <div className="divide-y">
                  {recentScheduleRuns.map((h) => {
                    const sched = schedules.find((s) => s.id === h.scheduleId);
                    return (
                      <div key={h.id} className="py-2 text-sm">
                        <div className="flex items-center gap-2">
                          {h.status === "completed" ? (
                            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
                          ) : (
                            <AlertCircle className="h-3.5 w-3.5 text-rose-500" />
                          )}
                          <span className="font-medium truncate">
                            {sched?.name ?? h.scheduleId}
                          </span>
                          <Badge variant="outline" className="ml-auto text-[10px]">
                            {new Date(h.startedAt).toLocaleString()}
                          </Badge>
                        </div>
                        <div className="text-xs text-muted-foreground pl-5 line-clamp-1">
                          {h.status === "completed"
                            ? h.outputPreview || "(empty)"
                            : h.error || "Unknown error"}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </ScrollArea>
          </CardContent>
        </Card>
      </div>

      {/* Execution drill-down */}
      <Dialog
        open={selectedExecution !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedExecutionId(null);
        }}
      >
        <DialogContent className="max-w-3xl max-h-[85vh] overflow-hidden flex flex-col">
          {selectedExecution && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  {selectedExecution.status === "completed" ? (
                    <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                  ) : selectedExecution.status === "failed" ? (
                    <AlertCircle className="h-4 w-4 text-rose-500" />
                  ) : (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  )}
                  {agentNameById.get(selectedExecution.agentId) ??
                    selectedExecution.agentId}
                  <Badge variant="outline" className="ml-2 text-[10px]">
                    {selectedExecution.status}
                  </Badge>
                  {selectedExecution.source && (
                    <Badge
                      variant="secondary"
                      className={`text-[10px] ${sourceBadgeClass(selectedExecution.source)}`}
                    >
                      {selectedExecution.source}
                    </Badge>
                  )}
                </DialogTitle>
                <DialogDescription className="font-mono text-xs">
                  {selectedExecution.id}
                </DialogDescription>
              </DialogHeader>

              <ScrollArea className="flex-1 -mx-6 px-6">
                <div className="space-y-4 py-2">
                  {/* Metrics strip */}
                  <div className="grid grid-cols-4 gap-2 text-xs">
                    <div className="rounded border p-2">
                      <div className="text-muted-foreground">Duration</div>
                      <div className="font-medium">
                        {formatMs(
                          selectedExecution.metrics?.totalDuration ?? 0,
                        )}
                      </div>
                    </div>
                    <div className="rounded border p-2">
                      <div className="text-muted-foreground">Tokens</div>
                      <div className="font-medium">
                        {selectedExecution.metrics?.tokensUsed?.total ?? 0}
                      </div>
                    </div>
                    <div className="rounded border p-2">
                      <div className="text-muted-foreground">Tool calls</div>
                      <div className="font-medium">
                        {selectedExecution.metrics?.toolCallCount ?? 0}
                      </div>
                    </div>
                    <div className="rounded border p-2">
                      <div className="text-muted-foreground">Iterations</div>
                      <div className="font-medium">
                        {selectedExecution.metrics?.iterationCount ?? 0}
                      </div>
                    </div>
                  </div>

                  {/* Timestamps */}
                  <div className="text-xs text-muted-foreground flex gap-4">
                    <span>
                      Started:{" "}
                      {new Date(selectedExecution.startedAt).toLocaleString()}
                    </span>
                    {selectedExecution.completedAt && (
                      <span>
                        Completed:{" "}
                        {new Date(
                          selectedExecution.completedAt,
                        ).toLocaleString()}
                      </span>
                    )}
                  </div>

                  {/* Error */}
                  {selectedExecution.error && (
                    <div className="rounded border border-rose-500/30 bg-rose-500/5 p-3">
                      <div className="text-xs font-semibold text-rose-600 dark:text-rose-400 mb-1">
                        Error
                      </div>
                      <pre className="text-xs whitespace-pre-wrap break-words">
                        {selectedExecution.error}
                      </pre>
                    </div>
                  )}

                  {/* Input */}
                  <div>
                    <div className="text-xs font-semibold mb-1">Input</div>
                    <pre className="text-xs rounded border bg-muted/40 p-2 max-h-40 overflow-auto whitespace-pre-wrap break-words">
                      {pretty(selectedExecution.input)}
                    </pre>
                  </div>

                  {/* Steps timeline */}
                  <div>
                    <div className="text-xs font-semibold mb-2">
                      Steps ({selectedExecution.steps?.length ?? 0})
                    </div>
                    {!selectedExecution.steps ||
                    selectedExecution.steps.length === 0 ? (
                      <p className="text-xs text-muted-foreground">
                        No steps recorded.
                      </p>
                    ) : (
                      <ol className="space-y-2">
                        {selectedExecution.steps.map((step, idx) => (
                          <li
                            key={step.id}
                            className="rounded border p-2 text-xs"
                          >
                            <div className="flex items-center gap-2 mb-1">
                              <span className="text-muted-foreground">
                                #{idx + 1}
                              </span>
                              {stepIcon(step.type)}
                              <span className="font-medium capitalize">
                                {step.type.replace("_", " ")}
                              </span>
                              {step.toolName && (
                                <Badge
                                  variant="outline"
                                  className="text-[9px] px-1 py-0"
                                >
                                  {step.toolName}
                                </Badge>
                              )}
                              <span className="ml-auto text-muted-foreground">
                                {new Date(step.timestamp).toLocaleTimeString()}
                                {step.duration
                                  ? ` · ${formatMs(step.duration)}`
                                  : ""}
                              </span>
                            </div>
                            {step.content && (
                              <div className="text-muted-foreground whitespace-pre-wrap break-words">
                                {step.content}
                              </div>
                            )}
                            {step.toolInput !== undefined && (
                              <details className="mt-1">
                                <summary className="cursor-pointer text-muted-foreground">
                                  tool input
                                </summary>
                                <pre className="mt-1 rounded bg-muted/40 p-1 max-h-32 overflow-auto whitespace-pre-wrap break-words">
                                  {pretty(step.toolInput)}
                                </pre>
                              </details>
                            )}
                            {step.toolOutput !== undefined && (
                              <details className="mt-1">
                                <summary className="cursor-pointer text-muted-foreground">
                                  tool output
                                </summary>
                                <pre className="mt-1 rounded bg-muted/40 p-1 max-h-32 overflow-auto whitespace-pre-wrap break-words">
                                  {pretty(step.toolOutput)}
                                </pre>
                              </details>
                            )}
                          </li>
                        ))}
                      </ol>
                    )}
                  </div>

                  {/* Output */}
                  {selectedExecution.output !== undefined && (
                    <div>
                      <div className="text-xs font-semibold mb-1">Output</div>
                      <pre className="text-xs rounded border bg-muted/40 p-2 max-h-60 overflow-auto whitespace-pre-wrap break-words">
                        {pretty(selectedExecution.output)}
                      </pre>
                    </div>
                  )}
                </div>
              </ScrollArea>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
