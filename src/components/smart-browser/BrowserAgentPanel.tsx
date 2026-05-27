/**
 * BrowserAgentPanel — autonomous web-agent UI.
 *
 * The user types a high-level task ("find the cheapest flight from JFK to
 * LAX next Friday"); the agent drives the active webview through a
 * plan/act/observe loop, streaming each step into the panel.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Bot,
  Square,
  Play,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Trash2,
} from "lucide-react";
import { BrowserAgentRunner } from "@/lib/browser_agent_runner";
import type {
  BrowserAgentRunState,
  BrowserAgentTurn,
} from "@/types/browser_agent";
import { cn } from "@/lib/utils";

interface Props {
  /** Returns the currently active <webview> tag, may change tab to tab. */
  getActiveWebview: () => Electron.WebviewTag | null;
  openTab: (url: string, opts?: { background?: boolean }) => void;
  /** Optional default agent id so save_memory works. */
  agentId?: number;
}

const SAMPLE_TASKS = [
  "Search Wikipedia for 'JoyCreate' and summarize the first paragraph.",
  "Find the top story on Hacker News and tell me its title + link.",
  "On the current page, fill the first search box with 'electron' and press Enter.",
];

export function BrowserAgentPanel({ getActiveWebview, openTab, agentId }: Props) {
  const [task, setTask] = useState("");
  const [state, setState] = useState<BrowserAgentRunState>({
    status: "idle",
    step: 0,
    task: "",
    history: [],
  });
  const [expandedSteps, setExpandedSteps] = useState<Record<number, boolean>>({});
  const runnerRef = useRef<BrowserAgentRunner | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);

  // Lazy-init the runner the first time we need it.
  const getRunner = useCallback((): BrowserAgentRunner => {
    if (!runnerRef.current) {
      runnerRef.current = new BrowserAgentRunner({
        getActiveWebview,
        openTab,
        agentId,
        onStateChange: (s) => setState({ ...s }),
      });
    }
    return runnerRef.current;
  }, [getActiveWebview, openTab, agentId]);

  // Re-create the runner if the active-webview accessor identity changes
  // (e.g., parent component remounted).
  useEffect(() => {
    runnerRef.current = null;
  }, [getActiveWebview, openTab, agentId]);

  // Autoscroll on each step.
  useEffect(() => {
    requestAnimationFrame(() => {
      logRef.current?.scrollTo({
        top: logRef.current.scrollHeight,
        behavior: "smooth",
      });
    });
  }, [state.history.length, state.status]);

  const isRunning = state.status === "running" || state.status === "stopping";

  const runTask = useCallback(
    async (t: string) => {
      const trimmed = t.trim();
      if (!trimmed || isRunning) return;
      setTask("");
      await getRunner().run(trimmed);
    },
    [getRunner, isRunning],
  );

  const stop = useCallback(() => {
    runnerRef.current?.stop();
  }, []);

  const clearHistory = useCallback(() => {
    if (isRunning) return;
    setState({ status: "idle", step: 0, task: "", history: [] });
    setExpandedSteps({});
  }, [isRunning]);

  const statusBadge = useMemo(() => {
    switch (state.status) {
      case "running":
        return { label: "running", color: "bg-amber-500/15 text-amber-600 border-amber-500/30" };
      case "stopping":
        return { label: "stopping", color: "bg-rose-500/15 text-rose-600 border-rose-500/30" };
      case "done":
        return { label: "done", color: "bg-emerald-500/15 text-emerald-600 border-emerald-500/30" };
      case "error":
        return { label: "error", color: "bg-rose-500/15 text-rose-600 border-rose-500/30" };
      case "stopped":
        return { label: "stopped", color: "bg-muted text-muted-foreground border-border" };
      default:
        return { label: "idle", color: "bg-muted text-muted-foreground border-border" };
    }
  }, [state.status]);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="sticky top-0 z-10 px-4 py-3 border-b border-border/50 bg-background/95 backdrop-blur flex items-center gap-2">
        <Bot className="h-4 w-4 text-sky-500" />
        <span className="font-semibold text-sm">Web Agent</span>
        <Badge variant="outline" className={cn("text-[10px] ml-1", statusBadge.color)}>
          {statusBadge.label}
        </Badge>
        {state.step > 0 && (
          <Badge variant="secondary" className="text-[10px]">
            step {state.step}
          </Badge>
        )}
        <div className="ml-auto flex items-center gap-1">
          {isRunning ? (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={stop}
              title="Stop agent"
            >
              <Square className="h-3.5 w-3.5 text-rose-500" />
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={clearHistory}
              disabled={state.history.length === 0}
              title="Clear log"
            >
              <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
            </Button>
          )}
        </div>
      </div>

      {/* Task input */}
      <div className="px-3 py-2 border-b border-border/40 space-y-2">
        <Textarea
          rows={3}
          placeholder='Give the agent a task — e.g., "Search Hacker News for the top story and summarize it"'
          value={task}
          onChange={(e) => setTask(e.target.value)}
          disabled={isRunning}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              runTask(task);
            }
          }}
          className="text-sm"
        />
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            onClick={() => runTask(task)}
            disabled={isRunning || !task.trim()}
            className="gap-1"
          >
            {isRunning ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Play className="h-3.5 w-3.5" />
            )}
            {isRunning ? "Working…" : "Run agent"}
          </Button>
          <span className="text-[10px] text-muted-foreground">
            Ctrl+Enter to run
          </span>
        </div>

        {state.history.length === 0 && !isRunning && (
          <div className="pt-1 flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Try
            </span>
            {SAMPLE_TASKS.map((t) => (
              <button
                key={t}
                type="button"
                className="text-left text-xs px-2 py-1 rounded border border-border/40 bg-muted/20 hover:bg-muted/40 transition-colors text-muted-foreground hover:text-foreground"
                onClick={() => setTask(t)}
              >
                {t}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Log */}
      <div ref={logRef} className="flex-1 overflow-y-auto px-3 py-3 space-y-2">
        {state.task && (
          <div className="text-xs rounded-lg border border-sky-500/30 bg-sky-500/5 px-3 py-2">
            <div className="text-[10px] uppercase tracking-wide text-sky-600 dark:text-sky-300 mb-0.5">
              Task
            </div>
            <div className="whitespace-pre-wrap">{state.task}</div>
          </div>
        )}

        {state.history.map((turn) => (
          <AgentTurnRow
            key={turn.step}
            turn={turn}
            expanded={!!expandedSteps[turn.step]}
            onToggle={() =>
              setExpandedSteps((m) => ({ ...m, [turn.step]: !m[turn.step] }))
            }
          />
        ))}

        {state.status === "done" && state.finalAnswer && (
          <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm">
            <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-emerald-700 dark:text-emerald-300 mb-1">
              <CheckCircle2 className="h-3 w-3" />
              Final answer
            </div>
            <div className="whitespace-pre-wrap">{state.finalAnswer}</div>
          </div>
        )}

        {state.status === "error" && state.errorMessage && (
          <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm">
            <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-rose-700 dark:text-rose-300 mb-1">
              <AlertTriangle className="h-3 w-3" />
              Agent error
            </div>
            <div className="whitespace-pre-wrap">{state.errorMessage}</div>
          </div>
        )}
      </div>
    </div>
  );
}

function AgentTurnRow({
  turn,
  expanded,
  onToggle,
}: {
  turn: BrowserAgentTurn;
  expanded: boolean;
  onToggle: () => void;
}) {
  const a = turn.action;
  const result = turn.observation?.result ?? "(pending)";
  const isErr = result.startsWith("ERROR");
  const paramsStr = a.params ? JSON.stringify(a.params) : "";

  return (
    <div
      className={cn(
        "rounded-lg border text-xs",
        isErr
          ? "border-rose-500/30 bg-rose-500/5"
          : "border-border/50 bg-card/40",
      )}
    >
      <button
        type="button"
        onClick={onToggle}
        className="w-full text-left px-2 py-1.5 flex items-start gap-1.5"
      >
        {expanded ? (
          <ChevronDown className="h-3 w-3 mt-0.5 text-muted-foreground shrink-0" />
        ) : (
          <ChevronRight className="h-3 w-3 mt-0.5 text-muted-foreground shrink-0" />
        )}
        <Badge variant="secondary" className="text-[10px] px-1 py-0 shrink-0">
          {turn.step}
        </Badge>
        <Badge
          variant="outline"
          className={cn(
            "text-[10px] px-1 py-0 shrink-0",
            a.action === "done"
              ? "border-emerald-500/40 text-emerald-600 dark:text-emerald-300"
              : "",
          )}
        >
          {a.action}
        </Badge>
        <span className="flex-1 truncate text-muted-foreground">
          {a.thought ?? paramsStr ?? ""}
        </span>
      </button>
      {expanded && (
        <div className="px-3 pb-2 pt-1 space-y-1.5 border-t border-border/40">
          {a.thought && (
            <div>
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                thought
              </span>
              <div className="whitespace-pre-wrap">{a.thought}</div>
            </div>
          )}
          {paramsStr && (
            <div>
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                params
              </span>
              <pre className="whitespace-pre-wrap break-words font-mono text-[10px] bg-muted/30 rounded px-1.5 py-1 border border-border/30">
                {paramsStr}
              </pre>
            </div>
          )}
          <div>
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
              result
            </span>
            <div className={cn("whitespace-pre-wrap", isErr && "text-rose-600 dark:text-rose-300")}>
              {result}
            </div>
          </div>
          {turn.observation?.url && (
            <div className="text-[10px] text-muted-foreground truncate">
              {turn.observation.url}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
