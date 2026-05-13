/**
 * AgentTracePage — step-by-step replay of a finished agent orchestration.
 *
 * Loads `Orchestration` by id via `orchestrator:get` and renders:
 *  - high-level summary (status, duration, task counts)
 *  - timeline scrubber over `trace: ExecutionTraceEntry[]`
 *  - per-task panel showing reflections (verdict, score, critique) when
 *    populated by the reflection engine
 *
 * This is read-only — debugging / observability surface, not editing.
 */

import { useMemo, useState } from "react";
import { useParams, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { IpcClient } from "@/ipc/ipc_client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ArrowLeft, Play, Pause, SkipBack, SkipForward } from "lucide-react";
import type {
  Orchestration,
  ExecutionTraceEntry,
  TaskNode,
  TaskReflection,
} from "@/types/agent_orchestrator";

export default function AgentTracePage() {
  const { orchestrationId } = useParams({ from: "/agent-trace/$orchestrationId" });

  const { data, isLoading, error } = useQuery<Orchestration | null>({
    queryKey: ["orchestration", orchestrationId],
    queryFn: async () => {
      const result = await IpcClient.getInstance().orchestratorGet(orchestrationId);
      return (result as Orchestration | null) ?? null;
    },
    enabled: Boolean(orchestrationId),
  });

  // Step cursor across trace entries. Defaults to "end" so the page opens
  // fully revealed; user can scrub backwards to replay.
  const trace: ExecutionTraceEntry[] = useMemo(() => data?.trace ?? [], [data]);
  const [stepIndex, setStepIndex] = useState<number>(-1); // -1 = show all

  const effectiveStep = stepIndex === -1 ? trace.length - 1 : stepIndex;
  const visibleTrace =
    stepIndex === -1 ? trace : trace.slice(0, stepIndex + 1);

  const tasks: TaskNode[] = data?.plan?.tasks ?? [];

  if (isLoading) {
    return <div className="p-6 text-muted-foreground">Loading trace…</div>;
  }
  if (error) {
    return (
      <div className="p-6 text-red-600 dark:text-red-400">
        Failed to load orchestration:{" "}
        {error instanceof Error ? error.message : String(error)}
      </div>
    );
  }
  if (!data) {
    return (
      <div className="p-6 space-y-3">
        <Link to="/agent-orchestrator" className="inline-flex items-center gap-1 text-sm underline">
          <ArrowLeft className="h-4 w-4" /> Back to orchestrator
        </Link>
        <p className="text-muted-foreground">No orchestration with id {orchestrationId}</p>
      </div>
    );
  }

  return (
    <div className="container mx-auto p-6 space-y-4 max-w-6xl">
      <header className="space-y-2">
        <Link
          to="/agent-orchestrator"
          className="inline-flex items-center gap-1 text-sm underline text-muted-foreground"
        >
          <ArrowLeft className="h-4 w-4" /> Back to orchestrator
        </Link>
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">Trace Replay</h1>
            <p className="text-sm text-muted-foreground font-mono">{data.id}</p>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant={data.status === "completed" ? "default" : "secondary"}>
              {data.status}
            </Badge>
            {typeof data.durationMs === "number" && (
              <Badge variant="outline">{(data.durationMs / 1000).toFixed(1)}s</Badge>
            )}
          </div>
        </div>
      </header>

      {/* Summary */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Input</CardTitle>
        </CardHeader>
        <CardContent className="text-sm whitespace-pre-wrap">
          {typeof data.input === "string"
            ? data.input
            : JSON.stringify(data.input, null, 2)}
        </CardContent>
      </Card>

      {/* Timeline scrubber */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center justify-between">
            <span>
              Timeline ({visibleTrace.length} / {trace.length})
            </span>
            <div className="flex items-center gap-1">
              <Button
                size="icon"
                variant="ghost"
                onClick={() => setStepIndex(0)}
                disabled={trace.length === 0}
              >
                <SkipBack className="h-4 w-4" />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                onClick={() =>
                  setStepIndex((i) =>
                    i === -1 ? Math.max(0, trace.length - 2) : Math.max(0, i - 1),
                  )
                }
                disabled={trace.length === 0}
              >
                <Pause className="h-4 w-4" />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                onClick={() =>
                  setStepIndex((i) => {
                    if (i === -1) return -1;
                    const next = i + 1;
                    return next >= trace.length - 1 ? -1 : next;
                  })
                }
                disabled={trace.length === 0}
              >
                <Play className="h-4 w-4" />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                onClick={() => setStepIndex(-1)}
                disabled={trace.length === 0}
              >
                <SkipForward className="h-4 w-4" />
              </Button>
            </div>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {trace.length > 0 && (
            <input
              type="range"
              min={0}
              max={trace.length - 1}
              value={effectiveStep < 0 ? 0 : effectiveStep}
              onChange={(e) => setStepIndex(Number(e.target.value))}
              className="w-full"
            />
          )}
          <ScrollArea className="h-64 rounded-md border">
            <div className="p-2 space-y-1 font-mono text-xs">
              {visibleTrace.length === 0 ? (
                <div className="text-muted-foreground">No trace entries yet.</div>
              ) : (
                visibleTrace.map((entry, i) => (
                  <div
                    key={entry.id ?? i}
                    className={`flex gap-2 px-2 py-1 rounded ${
                      i === effectiveStep ? "bg-muted" : ""
                    }`}
                  >
                    <span className="text-muted-foreground shrink-0 w-20">
                      {entry.timestamp
                        ? new Date(entry.timestamp).toLocaleTimeString()
                        : ""}
                    </span>
                    <Badge variant={levelVariant(entry.level)} className="shrink-0">
                      {entry.level}
                    </Badge>
                    <span className="text-muted-foreground shrink-0 w-32 truncate">
                      {entry.source}
                    </span>
                    <span className="flex-1 whitespace-pre-wrap break-words">
                      {entry.message}
                    </span>
                  </div>
                ))
              )}
            </div>
          </ScrollArea>
        </CardContent>
      </Card>

      {/* Per-task reflections */}
      {tasks.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Tasks &amp; Reflections</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {tasks.map((task) => (
              <TaskCard key={task.id} task={task} />
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function TaskCard({ task }: { task: TaskNode }) {
  const reflections: TaskReflection[] = task.reflections ?? [];
  return (
    <div className="border rounded-md p-3 space-y-2">
      <div className="flex items-center justify-between">
        <div>
          <div className="font-medium">{task.name}</div>
          {task.description && (
            <div className="text-xs text-muted-foreground">{task.description}</div>
          )}
        </div>
        <Badge variant={task.status === "completed" ? "default" : "secondary"}>
          {task.status}
        </Badge>
      </div>
      {reflections.length > 0 && (
        <div className="space-y-1 pt-1 border-t">
          <div className="text-xs font-semibold text-muted-foreground">
            Reflections ({reflections.length})
          </div>
          {reflections.map((r) => (
            <div key={r.attempt} className="text-xs flex gap-2 items-start">
              <Badge
                variant={
                  r.verdict === "accept"
                    ? "default"
                    : r.verdict === "retry"
                      ? "secondary"
                      : "destructive"
                }
              >
                #{r.attempt} {r.verdict}
              </Badge>
              <span className="text-muted-foreground shrink-0">
                score {r.score.toFixed(2)}
              </span>
              <span className="flex-1 whitespace-pre-wrap">{r.critique}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function levelVariant(
  level: ExecutionTraceEntry["level"],
): "default" | "secondary" | "destructive" | "outline" {
  switch (level) {
    case "error":
      return "destructive";
    case "warn":
      return "secondary";
    case "info":
      return "default";
    default:
      return "outline";
  }
}
