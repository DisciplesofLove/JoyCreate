/**
 * Left Gauntlet — operator console.
 *
 * Tabs: Run | History | Sessions | Settings.
 * Mounts the global progress bus once so live stage updates flow into the
 * `gauntletActiveRunsAtom` Jotai atom.
 */

import { useEffect, useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Hand,
  Eye,
  ShieldCheck,
  Anchor,
  RefreshCw,
  Copy,
  Trash2,
  Plus,
  Activity,
  Clock,
  AlertTriangle,
} from "lucide-react";
import { toast } from "sonner";
import {
  gauntletActiveRunsAtom,
  useGauntletExecute,
  useGauntletPing,
  useGauntletProgressBus,
  useGauntletRun,
  useGauntletRuns,
  useGauntletSessions,
} from "@/hooks/useGauntlet";
import { useAtomValue } from "jotai";
import type {
  GauntletRunRow,
  GauntletStage,
} from "@/ipc/ipc_client";

const stageStyle: Record<
  GauntletStage,
  { label: string; tone: string; Icon: typeof Hand }
> = {
  infiltrate: {
    label: "Infiltrate",
    tone: "bg-purple-500/15 text-purple-600 dark:text-purple-400",
    Icon: Hand,
  },
  extract: {
    label: "Extract",
    tone: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
    Icon: Eye,
  },
  sanitize: {
    label: "Sanitize",
    tone: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
    Icon: ShieldCheck,
  },
  anchor: {
    label: "Anchor",
    tone: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
    Icon: Anchor,
  },
};

function formatTs(ms: number | null | undefined): string {
  if (!ms) return "—";
  const t = ms < 1e12 ? ms * 1000 : ms;
  return new Date(t).toLocaleString();
}

export default function GauntletPage() {
  useGauntletProgressBus();

  return (
    <div className="container mx-auto p-6 space-y-6 max-w-6xl">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Hand className="h-6 w-6 text-purple-500" />
            Left Gauntlet
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Reach into the Dark Browser. Strip the poison. Anchor the truth.
          </p>
        </div>
        <Badge
          variant="outline"
          className="bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/30"
        >
          Whitehat enforced
        </Badge>
      </div>

      <Tabs defaultValue="run">
        <TabsList>
          <TabsTrigger value="run" className="gap-2">
            <Activity className="h-4 w-4" /> Run
          </TabsTrigger>
          <TabsTrigger value="history" className="gap-2">
            <Clock className="h-4 w-4" /> History
          </TabsTrigger>
          <TabsTrigger value="sessions" className="gap-2">
            <ShieldCheck className="h-4 w-4" /> Sessions
          </TabsTrigger>
          <TabsTrigger value="settings" className="gap-2">
            <RefreshCw className="h-4 w-4" /> Settings
          </TabsTrigger>
        </TabsList>

        <TabsContent value="run" className="mt-6">
          <RunPanel />
        </TabsContent>
        <TabsContent value="history" className="mt-6">
          <HistoryPanel />
        </TabsContent>
        <TabsContent value="sessions" className="mt-6">
          <SessionsPanel />
        </TabsContent>
        <TabsContent value="settings" className="mt-6">
          <SettingsPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ─── Run ────────────────────────────────────────────────────────────────────
function RunPanel() {
  const [url, setUrl] = useState("");
  const [intent, setIntent] = useState("");
  const [sessionId, setSessionId] = useState<string>("none");
  const [activeRunId, setActiveRunId] = useState<string | null>(null);

  const sessions = useGauntletSessions();
  const execute = useGauntletExecute();
  const progressMap = useAtomValue(gauntletActiveRunsAtom);
  const detail = useGauntletRun(activeRunId);

  const live = activeRunId ? progressMap[activeRunId] : undefined;

  const onEngage = () => {
    if (!url.trim()) {
      toast.error("Target URL required");
      return;
    }
    if (!intent.trim()) {
      toast.error("Intent text required");
      return;
    }
    execute.mutate(
      {
        targetUrl: url.trim(),
        intentText: intent.trim(),
        sessionId: sessionId === "none" ? undefined : sessionId,
      },
      {
        onSuccess: (r) => setActiveRunId(r.runId),
      },
    );
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <div className="space-y-4">
        <div>
          <Label>Target URL</Label>
          <Input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.com/pricing"
          />
        </div>
        <div>
          <Label>Intent</Label>
          <Textarea
            rows={3}
            value={intent}
            onChange={(e) => setIntent(e.target.value)}
            placeholder="Find the 2026 pricing tiers for the Pro plan"
          />
        </div>
        <div>
          <Label>Session</Label>
          <Select value={sessionId} onValueChange={setSessionId}>
            <SelectTrigger>
              <SelectValue placeholder="None (anonymous)" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">None (anonymous)</SelectItem>
              {(sessions.list.data ?? []).map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.label} — {s.originPattern}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button
          className="w-full"
          onClick={onEngage}
          disabled={execute.isPending}
        >
          <Hand className="mr-2 h-4 w-4" />
          {execute.isPending ? "Engaging…" : "Engage Gauntlet"}
        </Button>
      </div>

      <div className="space-y-4 rounded-lg border p-4 bg-muted/20">
        <div className="text-sm font-medium">Live pulse</div>
        <div className="grid grid-cols-4 gap-2">
          {(Object.keys(stageStyle) as GauntletStage[]).map((stage) => {
            const def = stageStyle[stage];
            const isLive = live?.stage === stage;
            const passed =
              live &&
              ["infiltrate", "extract", "sanitize", "anchor"].indexOf(
                live.stage,
              ) >
                ["infiltrate", "extract", "sanitize", "anchor"].indexOf(stage);
            return (
              <div
                key={stage}
                className={`flex flex-col items-center gap-1 rounded-md p-3 text-xs ${
                  isLive
                    ? `${def.tone} animate-pulse`
                    : passed
                      ? def.tone
                      : "bg-muted text-muted-foreground"
                }`}
              >
                <def.Icon className="h-4 w-4" />
                <span>{def.label}</span>
              </div>
            );
          })}
        </div>
        {live && (
          <div className="text-xs text-muted-foreground">
            {Math.round(live.progress * 100)}% — {live.message}
          </div>
        )}

        {detail.data?.status === "succeeded" && detail.data.markdownCid && (
          <div className="rounded-md bg-emerald-500/10 border border-emerald-500/30 p-3 text-xs space-y-1">
            <div className="flex items-center gap-2 font-medium text-emerald-700 dark:text-emerald-400">
              <Anchor className="h-3 w-3" /> Anchored
            </div>
            <div className="font-mono break-all">
              {detail.data.markdownCid}
            </div>
            {detail.data.integrityScore != null && (
              <div>
                Integrity {(detail.data.integrityScore * 100).toFixed(1)}%
              </div>
            )}
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                navigator.clipboard.writeText(detail.data!.markdown ?? "");
                toast.success("Markdown copied");
              }}
            >
              <Copy className="h-3 w-3 mr-1" /> Copy markdown
            </Button>
          </div>
        )}

        {detail.data?.status === "denied" && (
          <div className="rounded-md bg-rose-500/10 border border-rose-500/30 p-3 text-xs space-y-1">
            <div className="flex items-center gap-2 font-medium text-rose-700 dark:text-rose-400">
              <AlertTriangle className="h-3 w-3" /> Whitehat blocked
            </div>
            <div>{detail.data.errorMessage}</div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── History ────────────────────────────────────────────────────────────────
function HistoryPanel() {
  const runs = useGauntletRuns(100);
  const [openId, setOpenId] = useState<string | null>(null);
  const detail = useGauntletRun(openId);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-sm text-muted-foreground">
          {runs.data?.length ?? 0} runs
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => runs.refetch()}
          disabled={runs.isFetching}
        >
          <RefreshCw className="h-3 w-3 mr-1" /> Refresh
        </Button>
      </div>
      <div className="border rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/30 text-xs uppercase text-muted-foreground">
            <tr>
              <th className="text-left px-3 py-2">When</th>
              <th className="text-left px-3 py-2">Status</th>
              <th className="text-left px-3 py-2">URL</th>
              <th className="text-left px-3 py-2">CID</th>
              <th className="text-left px-3 py-2">Score</th>
              <th className="text-left px-3 py-2">ms</th>
            </tr>
          </thead>
          <tbody>
            {(runs.data ?? []).map((r: GauntletRunRow) => (
              <tr
                key={r.id}
                className="border-t hover:bg-muted/40 cursor-pointer"
                onClick={() => setOpenId(r.runId)}
              >
                <td className="px-3 py-2 text-xs whitespace-nowrap">
                  {formatTs(r.createdAt)}
                </td>
                <td className="px-3 py-2">
                  <StatusBadge status={r.status} />
                </td>
                <td className="px-3 py-2 truncate max-w-xs" title={r.targetUrl}>
                  {r.targetUrl}
                </td>
                <td className="px-3 py-2 font-mono text-[10px]">
                  {r.markdownCid ? `${r.markdownCid.slice(0, 12)}…` : "—"}
                </td>
                <td className="px-3 py-2 text-xs">
                  {r.integrityScore != null
                    ? r.integrityScore.toFixed(2)
                    : "—"}
                </td>
                <td className="px-3 py-2 text-xs">{r.durationMs ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {openId && detail.data && (
        <div className="border rounded-lg p-4 space-y-3 bg-muted/10">
          <div className="flex items-center justify-between">
            <div className="font-mono text-xs">{openId}</div>
            <Button size="sm" variant="ghost" onClick={() => setOpenId(null)}>
              Close
            </Button>
          </div>
          {detail.data.markdown && (
            <pre className="text-xs bg-muted p-3 rounded max-h-80 overflow-auto whitespace-pre-wrap">
              {detail.data.markdown.slice(0, 5000)}
            </pre>
          )}
          {detail.data.audit.length > 0 && (
            <div className="space-y-1">
              <div className="text-xs font-medium">Audit trail</div>
              {detail.data.audit.map((a) => (
                <div
                  key={a.id}
                  className="text-xs flex gap-2 items-center"
                >
                  <Badge variant="outline">{a.stage}</Badge>
                  <Badge
                    variant="outline"
                    className={
                      a.decision === "deny"
                        ? "border-rose-500/40 text-rose-600"
                        : a.decision === "strip"
                          ? "border-amber-500/40 text-amber-600"
                          : "border-emerald-500/40 text-emerald-600"
                    }
                  >
                    {a.decision}
                  </Badge>
                  <span className="text-muted-foreground">{a.reason}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const tone =
    status === "succeeded"
      ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
      : status === "denied"
        ? "bg-rose-500/15 text-rose-700 dark:text-rose-400"
        : status === "failed"
          ? "bg-orange-500/15 text-orange-700 dark:text-orange-400"
          : status === "running"
            ? "bg-blue-500/15 text-blue-700 dark:text-blue-400"
            : "bg-muted text-muted-foreground";
  return (
    <span className={`px-2 py-0.5 rounded text-xs font-medium ${tone}`}>
      {status}
    </span>
  );
}

// ─── Sessions ───────────────────────────────────────────────────────────────
function SessionsPanel() {
  const { list, create, remove } = useGauntletSessions();
  const [label, setLabel] = useState("");
  const [pattern, setPattern] = useState("");
  const [loginUrl, setLoginUrl] = useState("");

  return (
    <div className="space-y-6">
      <div className="border rounded-lg p-4 space-y-3 bg-muted/10">
        <div className="text-sm font-medium">Capture a new session</div>
        <p className="text-xs text-muted-foreground">
          Opens a window so you can log in. Cookies are encrypted with Electron
          safeStorage and reused on subsequent runs.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
          <Input
            placeholder="Label (e.g. 'Twitter Pro')"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
          <Input
            placeholder="Origin (https://twitter.com/*)"
            value={pattern}
            onChange={(e) => setPattern(e.target.value)}
          />
          <Input
            placeholder="Login URL"
            value={loginUrl}
            onChange={(e) => setLoginUrl(e.target.value)}
          />
        </div>
        <Button
          size="sm"
          disabled={create.isPending}
          onClick={() => {
            if (!label || !pattern || !loginUrl) {
              toast.error("All fields required");
              return;
            }
            create.mutate(
              { label, originPattern: pattern, loginUrl },
              {
                onSuccess: () => {
                  setLabel("");
                  setPattern("");
                  setLoginUrl("");
                  toast.success("Session captured");
                },
              },
            );
          }}
        >
          <Plus className="h-3 w-3 mr-1" /> Capture
        </Button>
      </div>

      <div className="border rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/30 text-xs uppercase text-muted-foreground">
            <tr>
              <th className="text-left px-3 py-2">Label</th>
              <th className="text-left px-3 py-2">Origin</th>
              <th className="text-left px-3 py-2">Last used</th>
              <th className="text-right px-3 py-2"> </th>
            </tr>
          </thead>
          <tbody>
            {(list.data ?? []).map((s) => (
              <tr key={s.id} className="border-t hover:bg-muted/40">
                <td className="px-3 py-2">{s.label}</td>
                <td className="px-3 py-2 font-mono text-xs">
                  {s.originPattern}
                </td>
                <td className="px-3 py-2 text-xs">{formatTs(s.lastUsedAt)}</td>
                <td className="px-3 py-2 text-right">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => remove.mutate(s.id)}
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Settings ───────────────────────────────────────────────────────────────
function SettingsPanel() {
  const { firecrawl, ollama } = useGauntletPing();
  return (
    <div className="space-y-4 max-w-2xl">
      <div className="rounded-md border bg-muted/10 p-4 space-y-2">
        <div className="text-sm font-medium">Health checks</div>
        <p className="text-xs text-muted-foreground">
          Firecrawl key is read from <code>FIRECRAWL_API_KEY</code> in your
          environment (or settings file). Ollama is expected at
          <code className="ml-1">{`$OLLAMA_HOST`}</code> (defaults to
          <code className="ml-1">http://localhost:11434</code>).
        </p>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={firecrawl.isPending}
            onClick={() => firecrawl.mutate()}
          >
            Test Firecrawl
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={ollama.isPending}
            onClick={() => ollama.mutate()}
          >
            Test Ollama
          </Button>
        </div>
      </div>
      <div className="rounded-md border bg-amber-500/5 border-amber-500/30 p-4 text-xs">
        L402 / BOLT12 micro-payment trigger is not yet wired. Sites that
        require sats per request will surface a <code>requiresPayment</code>
        progress event in a later release.
      </div>
    </div>
  );
}
