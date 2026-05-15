/**
 * AI Composer — in-editor agent panel for Code Studio.
 *
 * Uses the `code-studio:agent:run` IPC channel which talks to a real LLM
 * with workspace-scoped read / search / write tools. Streams progress
 * events into the panel and reloads the editor whenever the agent applies
 * a file change.
 */

import { useEffect, useRef, useState } from "react";
import {
  Sparkles,
  Send,
  Loader2,
  FilePlus,
  FileEdit,
  FileX,
  RefreshCw,
  StopCircle,
  Wrench,
  AlertTriangle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  codeStudioClient,
  type AgentFileChange,
  type AgentRunEvent,
} from "@/ipc/code_studio_client";

interface AIComposerProps {
  openFile: string | null;
  openFileContent: string | null;
  /** Called after the agent finishes so the editor can reload changed files. */
  onApplied: (paths: string[]) => void;
}

interface RunRecord {
  id: string;
  intent: string;
  summary: string;
  success: boolean;
  changes: AgentFileChange[];
  durationMs: number;
  events: AgentRunEvent[];
}

interface LiveRun {
  intent: string;
  startedAt: number;
  events: AgentRunEvent[];
  textBuffer: string;
  changes: Map<string, AgentFileChange>;
  runId: string | null;
}

export function AIComposer({
  openFile,
  openFileContent: _openFileContent,
  onApplied,
}: AIComposerProps) {
  const [intent, setIntent] = useState("");
  const [autoApprove, setAutoApprove] = useState(true);
  const [running, setRunning] = useState(false);
  const [history, setHistory] = useState<RunRecord[]>([]);
  const [live, setLive] = useState<LiveRun | null>(null);
  const liveRef = useRef<LiveRun | null>(null);
  liveRef.current = live;

  // Subscribe once for streaming events; route by runId.
  useEffect(() => {
    const unsubscribe = codeStudioClient.onAgentEvent((event) => {
      const current = liveRef.current;
      if (!current) return;
      if (current.runId == null && event.kind === "started") {
        current.runId = event.runId;
      }
      if (current.runId && event.runId !== current.runId) return;

      const next: LiveRun = {
        ...current,
        events: [...current.events, event],
      };
      if (event.kind === "text" && event.textDelta) {
        next.textBuffer = current.textBuffer + event.textDelta;
      }
      if (event.kind === "applied" && event.change) {
        next.changes = new Map(current.changes);
        next.changes.set(event.change.path, event.change);
        onApplied([event.change.path]);
      }
      setLive(next);
    });
    return unsubscribe;
  }, [onApplied]);

  async function run() {
    const description = intent.trim();
    if (!description || running) return;
    setRunning(true);
    setIntent("");
    const seed: LiveRun = {
      intent: description,
      startedAt: Date.now(),
      events: [],
      textBuffer: "",
      changes: new Map(),
      runId: null,
    };
    setLive(seed);
    liveRef.current = seed;

    try {
      const result = await codeStudioClient.agentRun({
        intent: description,
        openFile: openFile ?? null,
        autoApprove,
      });
      const finalChanges = result.changes.length
        ? result.changes
        : Array.from(liveRef.current?.changes.values() ?? []);
      const record: RunRecord = {
        id: result.runId,
        intent: description,
        summary: result.summary,
        success: result.finished && finalChanges.length > 0,
        changes: finalChanges,
        durationMs: Date.now() - seed.startedAt,
        events: liveRef.current?.events ?? [],
      };
      setHistory((prev) => [record, ...prev].slice(0, 20));
      if (finalChanges.length > 0) {
        onApplied(
          finalChanges.filter((c) => c.type !== "deleted").map((c) => c.path),
        );
        toast.success(`Agent: ${result.summary}`);
      } else {
        toast.message(result.summary);
      }
    } catch (err) {
      toast.error(`Agent error: ${(err as Error).message}`);
      const failureRecord: RunRecord = {
        id: liveRef.current?.runId ?? `fail_${Date.now()}`,
        intent: description,
        summary: (err as Error).message,
        success: false,
        changes: Array.from(liveRef.current?.changes.values() ?? []),
        durationMs: Date.now() - seed.startedAt,
        events: liveRef.current?.events ?? [],
      };
      setHistory((prev) => [failureRecord, ...prev].slice(0, 20));
    } finally {
      setRunning(false);
      setLive(null);
      liveRef.current = null;
    }
  }

  async function cancel() {
    const id = liveRef.current?.runId;
    if (!id) return;
    try {
      await codeStudioClient.agentCancel(id);
      toast.message("Agent cancelled");
    } catch (err) {
      toast.error(`Cancel failed: ${(err as Error).message}`);
    }
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border/40 bg-muted/30">
        <Sparkles className="h-4 w-4 text-primary" />
        <span className="text-sm font-medium">AI Composer</span>
        <div className="flex items-center gap-1.5 ml-auto">
          <Switch
            id="auto-approve"
            checked={autoApprove}
            onCheckedChange={setAutoApprove}
            disabled={running}
          />
          <Label
            htmlFor="auto-approve"
            className="text-[11px] text-muted-foreground cursor-pointer"
          >
            Auto-apply
          </Label>
        </div>
      </div>

      <div className="p-3 space-y-2 border-b border-border/40">
        <Textarea
          value={intent}
          onChange={(e) => setIntent(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              void run();
            }
          }}
          placeholder={
            openFile
              ? `Edit ${openFile.split("/").pop()}…\n(Ctrl+Enter to run)`
              : "Describe what you want the agent to build or change…\n(Ctrl+Enter to run)"
          }
          rows={3}
          className="text-sm font-mono resize-none"
          disabled={running}
        />
        <div className="flex gap-2">
          <Button
            onClick={run}
            disabled={running || !intent.trim()}
            size="sm"
            className="flex-1"
          >
            {running ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin mr-2" />
            ) : (
              <Send className="h-3.5 w-3.5 mr-2" />
            )}
            Run Agent
          </Button>
          {running && (
            <Button onClick={cancel} size="sm" variant="outline">
              <StopCircle className="h-3.5 w-3.5 mr-1" />
              Stop
            </Button>
          )}
        </div>
      </div>

      <ScrollArea className="flex-1">
        <div className="p-2 space-y-3">
          {live && <LiveRunCard run={live} />}
          {!live && history.length === 0 && (
            <div className="text-xs text-muted-foreground p-4 text-center">
              No runs yet. Describe what you want and press <kbd>Ctrl+Enter</kbd>.
            </div>
          )}
          {history.map((rec) => (
            <RunCard key={rec.id} record={rec} onReload={onApplied} />
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}

function LiveRunCard({ run }: { run: LiveRun }) {
  const tools = run.events.filter((e) => e.kind === "tool");
  const errors = run.events.filter((e) => e.kind === "error");
  const changes = Array.from(run.changes.values());
  return (
    <div className="rounded-md border border-primary/40 bg-primary/5 p-2 text-xs space-y-2">
      <div className="flex items-start gap-2">
        <Loader2 className="h-3.5 w-3.5 animate-spin text-primary mt-0.5 shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="font-medium truncate">{run.intent}</div>
          <div className="text-[10px] text-muted-foreground">
            {tools.length} tool calls · {changes.length} files touched
          </div>
        </div>
      </div>
      {tools.slice(-4).map((e, i) => (
        <div
          key={i}
          className="flex items-center gap-1.5 text-[10px] text-muted-foreground"
        >
          <Wrench className="h-2.5 w-2.5 shrink-0" />
          <span className="font-mono truncate">
            {e.toolName}
            {e.error ? ` — ${e.error}` : ""}
          </span>
        </div>
      ))}
      {run.textBuffer && (
        <div className="border-t border-border/40 pt-1.5 text-[11px] whitespace-pre-wrap">
          {run.textBuffer.slice(-600)}
        </div>
      )}
      {errors.length > 0 && (
        <div className="text-[10px] text-rose-500 flex items-center gap-1">
          <AlertTriangle className="h-3 w-3" />
          {errors[errors.length - 1].error}
        </div>
      )}
    </div>
  );
}

function RunCard({
  record,
  onReload,
}: {
  record: RunRecord;
  onReload: (paths: string[]) => void;
}) {
  return (
    <div
      className={cn(
        "rounded-md border p-2 text-xs",
        record.success
          ? "border-emerald-500/40 bg-emerald-500/5"
          : "border-amber-500/40 bg-amber-500/5",
      )}
    >
      <div className="flex items-start gap-2 mb-1">
        <Badge
          variant={record.success ? "default" : "secondary"}
          className="text-[10px]"
        >
          {record.success ? "ok" : "noop"}
        </Badge>
        <div className="flex-1 min-w-0">
          <div className="font-medium truncate">{record.intent}</div>
          <div className="text-muted-foreground text-[11px] line-clamp-2">
            {record.summary}
          </div>
        </div>
        <span className="text-[10px] text-muted-foreground/70 shrink-0">
          {(record.durationMs / 1000).toFixed(1)}s
        </span>
      </div>
      {record.changes.length > 0 && (
        <div className="space-y-1 mt-2 border-t border-border/30 pt-2">
          {record.changes.map((c, i) => (
            <ChangeRow key={`${c.path}-${i}`} change={c} onReload={onReload} />
          ))}
        </div>
      )}
    </div>
  );
}

function ChangeRow({
  change,
  onReload,
}: {
  change: AgentFileChange;
  onReload: (paths: string[]) => void;
}) {
  const Icon =
    change.type === "created"
      ? FilePlus
      : change.type === "deleted"
        ? FileX
        : FileEdit;
  const color =
    change.type === "created"
      ? "text-emerald-600 dark:text-emerald-400"
      : change.type === "deleted"
        ? "text-rose-600 dark:text-rose-400"
        : "text-blue-600 dark:text-blue-400";
  return (
    <div className="flex items-center gap-1.5">
      <Icon className={cn("h-3 w-3 shrink-0", color)} />
      <span className="font-mono text-[11px] truncate flex-1">{change.path}</span>
      {(change.linesAdded ?? 0) > 0 && (
        <span className="text-emerald-500 text-[10px] font-mono">
          +{change.linesAdded}
        </span>
      )}
      {(change.linesRemoved ?? 0) > 0 && (
        <span className="text-rose-500 text-[10px] font-mono">
          -{change.linesRemoved}
        </span>
      )}
      {change.type !== "deleted" && (
        <button
          type="button"
          onClick={() => onReload([change.path])}
          className="p-0.5 rounded hover:bg-accent"
          title="Reload in editor"
        >
          <RefreshCw className="h-2.5 w-2.5 text-muted-foreground" />
        </button>
      )}
    </div>
  );
}
