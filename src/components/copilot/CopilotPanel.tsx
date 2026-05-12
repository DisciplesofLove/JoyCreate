/**
 * CopilotPanel — chat-style UI for the NLP-driven self-healing assistant.
 *
 * Anyone (non-dev included) can type a plain-English request. The panel:
 *   1. Sends the prompt to the local Ollama router (free, private)
 *   2. Routes to: chat reply | safe read-only tool | Claude Code SDK
 *   3. For code-tasks, surfaces the diff for human Approve/Reject
 *   4. Streams in-flight progress so users see what's happening
 */

import { useMemo, useState } from "react";
import {
  Send,
  Loader2,
  CheckCircle2,
  XCircle,
  Wrench,
  MessageSquare,
  Code2,
  GitBranch,
  Clock,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  useCopilotAsk,
  useCopilotApprove,
  useCopilotCancel,
  useCopilotJobs,
  useCopilotProgress,
  useCopilotReject,
} from "@/hooks/useCopilot";
import type { CopilotJobRow } from "@/db/copilot_schema";

const KIND_ICON: Record<string, React.ReactNode> = {
  chat: <MessageSquare className="h-3.5 w-3.5" />,
  tool: <Wrench className="h-3.5 w-3.5" />,
  "code-task": <Code2 className="h-3.5 w-3.5" />,
};

const STATUS_VARIANT: Record<
  string,
  "default" | "secondary" | "destructive" | "outline"
> = {
  pending: "secondary",
  running: "secondary",
  "awaiting-approval": "default",
  completed: "outline",
  rejected: "destructive",
  failed: "destructive",
  cancelled: "outline",
};

export function CopilotPanel() {
  const [prompt, setPrompt] = useState("");
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);

  const ask = useCopilotAsk();
  const approve = useCopilotApprove();
  const reject = useCopilotReject();
  const cancel = useCopilotCancel();
  const jobsQuery = useCopilotJobs(50);
  const progress = useCopilotProgress(50);

  const jobs = jobsQuery.data ?? [];
  const selectedJob = useMemo(
    () => jobs.find((j) => j.id === selectedJobId) ?? null,
    [jobs, selectedJobId],
  );

  const submit = () => {
    const text = prompt.trim();
    if (!text) return;
    progress.clear();
    ask.mutate(
      { prompt: text },
      {
        onSuccess: (job) => {
          setSelectedJobId(job.id);
          setPrompt("");
        },
      },
    );
  };

  return (
    <div className="grid h-full grid-cols-[320px_1fr] gap-4 p-4">
      {/* Job history */}
      <Card className="flex h-full flex-col">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-semibold">Recent jobs</CardTitle>
        </CardHeader>
        <CardContent className="flex-1 overflow-hidden p-0">
          <ScrollArea className="h-full">
            <div className="space-y-1 p-2">
              {jobs.length === 0 && (
                <p className="px-2 py-4 text-center text-xs text-muted-foreground">
                  No copilot jobs yet. Ask something below.
                </p>
              )}
              {jobs.map((job) => (
                <button
                  key={job.id}
                  type="button"
                  onClick={() => setSelectedJobId(job.id)}
                  className={`w-full rounded-md border p-2 text-left text-xs transition-colors hover:bg-accent ${
                    selectedJobId === job.id
                      ? "border-primary bg-accent"
                      : "border-border"
                  }`}
                >
                  <div className="mb-1 flex items-center justify-between gap-2">
                    <span className="flex items-center gap-1 font-medium">
                      {KIND_ICON[job.kind] ?? null}
                      {job.kind}
                    </span>
                    <Badge
                      variant={STATUS_VARIANT[job.status] ?? "outline"}
                      className="text-[10px]"
                    >
                      {job.status}
                    </Badge>
                  </div>
                  <p className="line-clamp-2 text-muted-foreground">
                    {job.userPrompt}
                  </p>
                  <p className="mt-1 flex items-center gap-1 text-[10px] text-muted-foreground">
                    <Clock className="h-3 w-3" />
                    {new Date(job.createdAt).toLocaleString()}
                  </p>
                </button>
              ))}
            </div>
          </ScrollArea>
        </CardContent>
      </Card>

      {/* Detail + composer */}
      <div className="flex h-full flex-col gap-4">
        <Card className="flex-1 overflow-hidden">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold">
              {selectedJob ? "Job detail" : "Welcome"}
            </CardTitle>
          </CardHeader>
          <CardContent className="h-[calc(100%-3rem)] overflow-hidden p-0">
            <ScrollArea className="h-full">
              <div className="space-y-4 p-4 text-sm">
                {!selectedJob && <WelcomeMessage />}
                {selectedJob && (
                  <JobDetail
                    job={selectedJob}
                    progressChunks={
                      selectedJob.status === "running" ||
                      selectedJob.status === "pending"
                        ? progress.chunks
                        : []
                    }
                    onApprove={() =>
                      approve.mutate({ jobId: selectedJob.id })
                    }
                    onReject={(reason) =>
                      reject.mutate({ jobId: selectedJob.id, reason })
                    }
                    onCancel={() => cancel.mutate({ jobId: selectedJob.id })}
                    busy={
                      approve.isPending ||
                      reject.isPending ||
                      cancel.isPending
                    }
                  />
                )}
              </div>
            </ScrollArea>
          </CardContent>
        </Card>

        {/* Composer */}
        <Card>
          <CardContent className="space-y-2 p-3">
            <Textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Ask anything in plain English… e.g. 'Show federation peers' or 'Fix the failing payment_handler test'"
              className="min-h-[80px] resize-none"
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  submit();
                }
              }}
              disabled={ask.isPending}
            />
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>
                Local Ollama routes &middot; Claude Code handles edits &middot;
                You approve diffs
              </span>
              <Button
                size="sm"
                onClick={submit}
                disabled={ask.isPending || !prompt.trim()}
              >
                {ask.isPending ? (
                  <>
                    <Loader2 className="mr-2 h-3 w-3 animate-spin" />
                    Thinking…
                  </>
                ) : (
                  <>
                    <Send className="mr-2 h-3 w-3" />
                    Send (Ctrl+Enter)
                  </>
                )}
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function WelcomeMessage() {
  return (
    <div className="space-y-3 text-muted-foreground">
      <p className="text-base font-medium text-foreground">
        Hi — I'm your JoyCreate Copilot.
      </p>
      <p>Ask me anything in plain English. I can:</p>
      <ul className="ml-4 list-disc space-y-1">
        <li>
          <strong>Answer questions</strong> about how the app works
        </li>
        <li>
          <strong>Look up data</strong> like peers, listings, transactions, MCP
          audit logs
        </li>
        <li>
          <strong>Fix bugs &amp; edit code</strong> via Claude Code on a
          throwaway branch — you review the diff before anything lands
        </li>
      </ul>
      <p className="text-xs">
        Every request is classified locally by Ollama (free, private). Heavy
        edits dispatch to Claude only when needed, and stay sandboxed on a
        per-job branch until you approve.
      </p>
    </div>
  );
}

function JobDetail({
  job,
  progressChunks,
  onApprove,
  onReject,
  onCancel,
  busy,
}: {
  job: CopilotJobRow;
  progressChunks: { stage: string; content: string; ts: number }[];
  onApprove: () => void;
  onReject: (reason?: string) => void;
  onCancel: () => void;
  busy: boolean;
}) {
  return (
    <div className="space-y-3">
      <div className="rounded-md bg-muted p-3">
        <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          You asked
        </p>
        <p className="whitespace-pre-wrap">{job.userPrompt}</p>
      </div>

      {job.summary && (
        <div className="rounded-md border p-3">
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Summary
          </p>
          <p>{job.summary}</p>
        </div>
      )}

      {progressChunks.length > 0 && (
        <div className="rounded-md border border-blue-500/30 bg-blue-500/5 p-3">
          <p className="mb-1 flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-blue-600">
            <Loader2 className="h-3 w-3 animate-spin" />
            Live progress
          </p>
          <div className="max-h-40 space-y-1 overflow-y-auto font-mono text-xs">
            {progressChunks.map((c, i) => (
              <div key={i}>
                <span className="text-blue-500">[{c.stage}]</span> {c.content}
              </div>
            ))}
          </div>
        </div>
      )}

      {job.kind === "code-task" && job.branchName && (
        <div className="rounded-md border p-3">
          <p className="mb-1 flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <GitBranch className="h-3 w-3" />
            Branch
          </p>
          <code className="text-xs">{job.branchName}</code>
          {job.diffPath && (
            <p className="mt-1 text-[10px] text-muted-foreground">
              Diff: {job.diffPath}
            </p>
          )}
          {typeof job.claudeCostUsd !== "undefined" && job.claudeCostUsd && (
            <p className="text-[10px] text-muted-foreground">
              Cost: ${job.claudeCostUsd}
            </p>
          )}
        </div>
      )}

      {job.output && (
        <div className="rounded-md border p-3">
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Output
          </p>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap font-mono text-xs">
            {job.output}
          </pre>
        </div>
      )}

      {job.errorMessage && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3">
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-destructive">
            Error
          </p>
          <p className="text-xs">{job.errorMessage}</p>
        </div>
      )}

      {/* Action buttons */}
      <div className="flex flex-wrap gap-2 pt-2">
        {job.status === "awaiting-approval" && (
          <>
            <Button size="sm" onClick={onApprove} disabled={busy}>
              <CheckCircle2 className="mr-1 h-3 w-3" />
              Approve diff
            </Button>
            <Button
              size="sm"
              variant="destructive"
              onClick={() => onReject()}
              disabled={busy}
            >
              <XCircle className="mr-1 h-3 w-3" />
              Reject
            </Button>
          </>
        )}
        {(job.status === "running" || job.status === "pending") && (
          <Button
            size="sm"
            variant="outline"
            onClick={onCancel}
            disabled={busy}
          >
            Cancel
          </Button>
        )}
      </div>
    </div>
  );
}
