import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  Circle,
  Loader2,
  AlertCircle,
  SkipForward,
  RotateCcw,
  Trash2,
  Play,
} from "lucide-react";
import { IpcClient } from "@/ipc/ipc_client";
import type {
  ChatPlan,
  ChatPlanPhase,
} from "@/shared/chat_plan_types";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useStreamChat } from "@/hooks/useStreamChat";
import { showError, showSuccess } from "@/lib/toast";
import { cn } from "@/lib/utils";

interface ChatPlanPanelProps {
  chatId: number;
}

const STATUS_ICON: Record<ChatPlanPhase["status"], React.ReactNode> = {
  pending: <Circle className="h-4 w-4 text-muted-foreground" />,
  running: <Loader2 className="h-4 w-4 animate-spin text-primary" />,
  done: <CheckCircle2 className="h-4 w-4 text-emerald-500" />,
  failed: <AlertCircle className="h-4 w-4 text-red-500" />,
  skipped: <SkipForward className="h-4 w-4 text-amber-500" />,
};

const STATUS_LABEL: Record<ChatPlanPhase["status"], string> = {
  pending: "Pending",
  running: "Running",
  done: "Done",
  failed: "Failed",
  skipped: "Skipped",
};

const AUTO_RUN_STORAGE_PREFIX = "joycreate.chatPlan.autoRun.";

export function ChatPlanPanel({ chatId }: ChatPlanPanelProps) {
  const queryClient = useQueryClient();
  const { streamMessage, isStreaming } = useStreamChat();

  const { data: plan } = useQuery<ChatPlan | null>({
    queryKey: ["chat-plan", chatId],
    queryFn: () => IpcClient.getInstance().getChatPlan(chatId),
    enabled: Number.isFinite(chatId),
    refetchInterval: 4000,
  });

  // Auto-run preference is purely renderer-side; persisted per-chat in
  // localStorage so reloads keep the user's choice without a DB migration.
  const autoRunKey = `${AUTO_RUN_STORAGE_PREFIX}${chatId}`;
  const [autoRun, setAutoRun] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(autoRunKey) === "1";
  });
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(autoRunKey, autoRun ? "1" : "0");
  }, [autoRun, autoRunKey]);

  const updatePhase = useMutation({
    mutationFn: (params: {
      phaseId: string;
      patch: Partial<ChatPlanPhase>;
    }) =>
      IpcClient.getInstance().updateChatPlanPhase({
        chatId,
        phaseId: params.phaseId,
        patch: params.patch,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["chat-plan", chatId] });
    },
    onError: (err: Error) => showError(err.message),
  });

  const resetPlan = useMutation({
    mutationFn: () => IpcClient.getInstance().resetChatPlan(chatId),
    onSuccess: () => {
      showSuccess("Plan cleared");
      queryClient.invalidateQueries({ queryKey: ["chat-plan", chatId] });
    },
    onError: (err: Error) => showError(err.message),
  });

  const startNext = useMutation({
    mutationFn: () =>
      IpcClient.getInstance().startNextChatPlanPhase(chatId),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["chat-plan", chatId] });
      if (!result) {
        showSuccess("All phases complete");
        return;
      }
      streamMessage({ prompt: result.prompt, chatId });
    },
    onError: (err: Error) => showError(err.message),
  });

  const progress = useMemo(() => {
    if (!plan) return { done: 0, total: 0 };
    const done = plan.phases.filter(
      (p) => p.status === "done" || p.status === "skipped",
    ).length;
    return { done, total: plan.phases.length };
  }, [plan]);

  const hasPending = useMemo(
    () => (plan?.phases ?? []).some((p) => p.status === "pending"),
    [plan],
  );
  const hasRunning = useMemo(
    () => (plan?.phases ?? []).some((p) => p.status === "running"),
    [plan],
  );

  // Auto-advance loop: when the previous stream finishes and auto-run is on,
  // kick off the next pending phase. Guarded by a ref so we don't loop on
  // every re-render and only fire on streaming false-edges.
  const wasStreamingRef = useRef(false);
  useEffect(() => {
    const justFinished = wasStreamingRef.current && !isStreaming;
    wasStreamingRef.current = isStreaming;
    if (!autoRun) return;
    if (!justFinished) return;
    if (!plan) return;
    if (plan.status === "failed" || plan.status === "completed") return;
    if (!hasPending) return;
    if (hasRunning) return;
    if (startNext.isPending) return;
    startNext.mutate();
  }, [
    isStreaming,
    autoRun,
    plan,
    hasPending,
    hasRunning,
    startNext,
  ]);

  if (!plan) return null;

  const canStart = !isStreaming && !hasRunning && hasPending;
  const startLabel =
    plan.status === "draft" ? "Start plan" : "Continue";

  return (
    <div className="border-b border-border/50 bg-muted/30 px-3 py-2">
      <div className="flex items-center justify-between mb-2">
        <div className="min-w-0">
          <div className="text-xs font-semibold text-foreground truncate">
            Agent Plan
          </div>
          <div className="text-xs text-muted-foreground truncate">
            {plan.goal}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <label
            className="flex items-center gap-1.5 text-[11px] text-muted-foreground select-none"
            title="When on, the agent automatically starts the next pending phase whenever a turn finishes"
          >
            <Switch
              checked={autoRun}
              onCheckedChange={setAutoRun}
              className="scale-75 origin-right"
            />
            <span>Auto-run</span>
          </label>
          <span className="text-xs text-muted-foreground">
            {progress.done}/{progress.total}
          </span>
          <Button
            size="sm"
            variant="default"
            className="h-6 px-2 gap-1"
            onClick={() => startNext.mutate()}
            disabled={!canStart || startNext.isPending}
            title={
              canStart
                ? `${startLabel} — runs the next pending phase`
                : hasRunning
                  ? "A phase is already running"
                  : "No pending phases"
            }
          >
            <Play className="h-3 w-3" />
            <span className="text-xs">{startLabel}</span>
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2"
            onClick={() => resetPlan.mutate()}
            disabled={resetPlan.isPending}
            title="Clear plan"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
      <ol className="space-y-1">
        {plan.phases.map((phase, idx) => (
          <li
            key={phase.id}
            className={cn(
              "flex items-start gap-2 rounded px-2 py-1.5 text-xs",
              phase.status === "running" && "bg-primary/10",
              phase.status === "failed" && "bg-red-500/10",
            )}
          >
            <div className="mt-0.5 shrink-0">{STATUS_ICON[phase.status]}</div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="font-medium text-foreground truncate">
                  {idx + 1}. {phase.title}
                </span>
                <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  {STATUS_LABEL[phase.status]}
                </span>
              </div>
              {phase.description && (
                <div className="text-muted-foreground mt-0.5 line-clamp-2">
                  {phase.description}
                </div>
              )}
              {phase.summary && phase.status === "done" && (
                <div className="text-emerald-600 dark:text-emerald-400 mt-0.5 line-clamp-2">
                  {phase.summary}
                </div>
              )}
              {phase.error && (
                <div className="text-red-500 mt-0.5 line-clamp-2">
                  {phase.error}
                </div>
              )}
            </div>
            <div className="flex shrink-0 gap-1">
              {phase.status === "failed" && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-1.5"
                  onClick={() =>
                    updatePhase.mutate({
                      phaseId: phase.id,
                      patch: { status: "pending", error: undefined },
                    })
                  }
                  title="Retry phase"
                >
                  <RotateCcw className="h-3 w-3" />
                </Button>
              )}
              {(phase.status === "pending" || phase.status === "failed") && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-1.5"
                  onClick={() =>
                    updatePhase.mutate({
                      phaseId: phase.id,
                      patch: { status: "skipped" },
                    })
                  }
                  title="Skip phase"
                >
                  <SkipForward className="h-3 w-3" />
                </Button>
              )}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
