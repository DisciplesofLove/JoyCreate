/**
 * Genius Core — Control Panel
 *
 * Single surface that exposes Genius Core's runtime status, settings,
 * context slots, distillation scheduler, eval/quality scoring, and
 * privacy toggles. Every section is read via TanStack Query and writes
 * go through dedicated mutation hooks so renderer state stays in sync
 * with main-process settings + scheduler state.
 *
 * The page is structured so a user can answer at a glance:
 *   1. "Is Genius Core running, and on what model?"
 *   2. "How well is my locally-fine-tuned adapter performing?"
 *   3. "Will it auto-rollback if it regresses?"
 *   4. "What's being captured for training, and can I turn it off?"
 */

import React, { useMemo, useState } from "react";
import { useAtomValue } from "jotai";
import {
  Activity,
  BrainCircuit,
  Cpu,
  HardDrive,
  History,
  Layers,
  PlayCircle,
  RotateCcw,
  Save,
  ShieldCheck,
  Sparkles,
  Target,
} from "lucide-react";

import { selectedAppIdAtom } from "@/atoms/appAtoms";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

import {
  useGeniusCoreBaseModels,
  useGeniusCoreStatus,
  useInitGeniusCore,
  useSetGeniusCoreBaseModel,
} from "@/hooks/useGeniusCore";
import {
  useGeniusCoreDistillationStatus,
  useRunGeniusCoreDistillation,
  useSetGeniusCoreDistillationEnabled,
} from "@/hooks/useGeniusCoreDistillation";
import {
  useGeniusCoreAdapterScores,
  useGeniusCoreEvalSet,
  useSetGeniusCoreEvalSet,
  useSetGeniusCoreRollbackThreshold,
} from "@/hooks/useGeniusCoreAdapterQuality";
import { useSettings } from "@/hooks/useSettings";

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatScore(s: number | null | undefined): string {
  if (s === null || s === undefined || !Number.isFinite(s)) return "—";
  return `${(s * 100).toFixed(1)}%`;
}

function formatAgo(ms: number | null | undefined): string {
  if (!ms) return "never";
  const diff = Date.now() - ms;
  if (diff < 60_000) return `${Math.max(1, Math.round(diff / 1000))}s ago`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return `${Math.round(diff / 86_400_000)}d ago`;
}

// ─────────────────────────────────────────────────────────────────────────
// Page
// ─────────────────────────────────────────────────────────────────────────

const GeniusCoreControlPanel: React.FC = () => {
  const selectedAppId = useAtomValue(selectedAppIdAtom);
  const projectId = selectedAppId ?? null;

  return (
    <div className="h-full overflow-y-auto px-8 py-6 space-y-8">
      <header className="relative overflow-hidden rounded-2xl border border-fuchsia-500/20 bg-gradient-to-r from-fuchsia-500/10 via-purple-500/10 to-indigo-500/10 p-8">
        <div className="flex items-center gap-5">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-fuchsia-500 to-purple-500 shadow-lg shadow-fuchsia-500/25">
            <BrainCircuit className="h-7 w-7 text-white" />
          </div>
          <div>
            <h1 className="text-3xl font-extrabold bg-gradient-to-r from-fuchsia-500 via-purple-500 to-indigo-500 bg-clip-text text-transparent">
              Genius Core
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Your local ONNX runtime, context slots, adapter distillation,
              and quality scoring — all in one place.
            </p>
          </div>
        </div>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <StatusCard />
        <EngineSettingsCard />
        <BaseModelCard />
        <PrivacyCard />
        <DistillationCard projectId={projectId} />
        <EvalQualityCard projectId={projectId} />
      </div>
    </div>
  );
};

export default GeniusCoreControlPanel;

// ─────────────────────────────────────────────────────────────────────────
// Status
// ─────────────────────────────────────────────────────────────────────────

const StatusCard: React.FC = () => {
  const { data, isLoading } = useGeniusCoreStatus();
  const init = useInitGeniusCore();

  const statusColor = useMemo(() => {
    switch (data?.status) {
      case "ready":
      case "inferring":
        return "text-emerald-500";
      case "initializing":
      case "loading-base":
      case "loading-context-slot":
        return "text-amber-500";
      case "error":
        return "text-rose-500";
      default:
        return "text-muted-foreground";
    }
  }, [data?.status]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Activity className="h-5 w-5" /> Runtime Status
        </CardTitle>
        <CardDescription>
          Live snapshot from the local ONNX runtime backend.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-2 gap-4 text-sm">
          <Stat label="Status">
            <span className={cn("font-semibold capitalize", statusColor)}>
              {isLoading ? "…" : data?.status ?? "unknown"}
            </span>
          </Stat>
          <Stat label="Execution Provider">
            {data?.executionProvider ?? "—"}
          </Stat>
          <Stat label="Base Model">
            <span className="font-mono text-xs">
              {data?.baseModelId ?? "—"}
            </span>
          </Stat>
          <Stat label="VRAM Used">
            {data?.vramUsedBytes != null
              ? formatBytes(data.vramUsedBytes)
              : "—"}
          </Stat>
          <Stat label="Loaded Slots">
            <span className="font-mono text-xs break-all">
              {data?.loadedContextSlots?.length
                ? data.loadedContextSlots.join(", ")
                : "—"}
            </span>
          </Stat>
          <Stat label="Last Error">
            {data?.lastError ? (
              <span className="text-rose-500 text-xs">{data.lastError}</span>
            ) : (
              <span className="text-muted-foreground">none</span>
            )}
          </Stat>
          <Stat label="Last Inference">
            {data?.lastInference ? (
              <span
                className={cn(
                  "text-xs font-medium",
                  data.lastInference.usedShardStream
                    ? "text-sky-500"
                    : "text-emerald-500",
                )}
                title={`${data.lastInference.tokensOut} tokens in ${data.lastInference.durationMs} ms`}
              >
                {data.lastInference.usedShardStream
                  ? "peer-streamed"
                  : "local"}
              </span>
            ) : (
              <span className="text-muted-foreground">—</span>
            )}
          </Stat>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => init.mutate()}
          disabled={init.isPending}
        >
          {init.isPending ? "Initializing…" : "Initialize"}
        </Button>
      </CardContent>
    </Card>
  );
};

// ─────────────────────────────────────────────────────────────────────────
// Engine settings
// ─────────────────────────────────────────────────────────────────────────

const EngineSettingsCard: React.FC = () => {
  const { settings } = useSettings();
  const gc = settings?.geniusCore;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Cpu className="h-5 w-5" /> Engine Settings
        </CardTitle>
        <CardDescription>
          Read-only — edit in main Settings &gt; Genius Core.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <Stat label="Enabled">{gc?.enabled ? "yes" : "no"}</Stat>
        <Stat label="VRAM Budget">{gc?.vramBudgetGb ?? 8} GB</Stat>
        <Stat label="Execution Provider">{gc?.executionProvider ?? "auto"}</Stat>
        <Stat label="NPU Offload">{gc?.npuOffloadEnabled ? "on" : "off"}</Stat>
        <Stat label="Weight Streaming">
          {gc?.weightStreamingEnabled ? "on" : "off"}
        </Stat>
      </CardContent>
    </Card>
  );
};

// ─────────────────────────────────────────────────────────────────────────
// Base model picker
// ─────────────────────────────────────────────────────────────────────────

const BaseModelCard: React.FC = () => {
  const { data: status } = useGeniusCoreStatus();
  const { data: models = [], isLoading } = useGeniusCoreBaseModels();
  const setModel = useSetGeniusCoreBaseModel();
  const [draft, setDraft] = useState<string | null>(null);
  const current = status?.baseModelId ?? null;
  const selected = draft ?? current ?? "";

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Layers className="h-5 w-5" /> Base Model
        </CardTitle>
        <CardDescription>
          Swap the foundation layer. Switching forces a runtime reload on
          next inference.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Select
          value={selected}
          onValueChange={(v) => setDraft(v)}
          disabled={isLoading || setModel.isPending}
        >
          <SelectTrigger>
            <SelectValue placeholder="Choose a base model…" />
          </SelectTrigger>
          <SelectContent>
            {models.map((m) => (
              <SelectItem key={m.id} value={m.id}>
                <span className="font-medium">{m.displayName}</span>
                <span className="ml-2 text-xs text-muted-foreground">
                  {m.quantization} · {formatBytes(m.approxBytes)}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            onClick={() => {
              if (!draft || draft === current) return;
              setModel.mutate(draft, {
                onSuccess: () => setDraft(null),
              });
            }}
            disabled={!draft || draft === current || setModel.isPending}
          >
            {setModel.isPending ? "Swapping…" : "Apply"}
          </Button>
          {draft && draft !== current && (
            <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>
              Cancel
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
};

// ─────────────────────────────────────────────────────────────────────────
// Privacy
// ─────────────────────────────────────────────────────────────────────────

const PrivacyCard: React.FC = () => {
  const { settings } = useSettings();
  const gc = settings?.geniusCore;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldCheck className="h-5 w-5" /> Privacy
        </CardTitle>
        <CardDescription>
          Everything below stays local unless explicitly opted in.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <Stat label="Edit Logger">
          {gc?.keystrokeLoggerEnabled ? "capturing" : "off"}
        </Stat>
        <Stat label="Hyper Replication (metadata only)">
          {gc?.hyperReplicationEnabled ? "on" : "off"}
        </Stat>
        <Stat label="Federated Distillation">
          {gc?.federatedDistillationEnabled ? "on" : "off"}
        </Stat>
        <p className="text-xs text-muted-foreground pt-2">
          Adapter bytes and raw edits never leave this device. The Hypercore
          mirror replicates only IPLD CIDs, batch hashes, and distillation
          receipts under the <code>genius-core</code> scope.
        </p>
      </CardContent>
    </Card>
  );
};

// ─────────────────────────────────────────────────────────────────────────
// Distillation
// ─────────────────────────────────────────────────────────────────────────

const DistillationCard: React.FC<{ projectId: number | null }> = ({
  projectId,
}) => {
  const status = useGeniusCoreDistillationStatus();
  const setEnabled = useSetGeniusCoreDistillationEnabled();
  const runNow = useRunGeniusCoreDistillation();
  const { settings } = useSettings();
  const enabled = settings?.geniusCore?.nightlyDistillationEnabled ?? false;
  const last = status.data?.lastRun;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Sparkles className="h-5 w-5" /> Distillation
        </CardTitle>
        <CardDescription>
          Continuous QLoRA training of project-specific adapters during idle
          periods.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <Label className="text-sm">Nightly idle distillation</Label>
            <p className="text-xs text-muted-foreground">
              Requires ≥10 min idle and AC power.
            </p>
          </div>
          <Switch
            checked={enabled}
            onCheckedChange={(v) => setEnabled.mutate(v)}
            disabled={setEnabled.isPending}
          />
        </div>

        <div className="grid grid-cols-2 gap-3 text-sm">
          <Stat label="Running">{status.data?.running ? "yes" : "no"}</Stat>
          <Stat label="Total Runs">{status.data?.runCount ?? 0}</Stat>
          <Stat label="Last Adapter">
            <span className="font-mono text-xs break-all">
              {last?.adapterId ?? "—"}
            </span>
          </Stat>
          <Stat label="Last Loss">
            {last ? last.finalLoss.toFixed(4) : "—"}
          </Stat>
          <Stat label="Samples">{last?.sampleCount ?? "—"}</Stat>
          <Stat label="Last Run">
            {last ? formatAgo(last.finishedAtMs) : "never"}
          </Stat>
        </div>

        <div className="flex items-center gap-2">
          <Button
            size="sm"
            onClick={() => projectId && runNow.mutate(projectId)}
            disabled={!projectId || runNow.isPending || status.data?.running}
          >
            <PlayCircle className="h-4 w-4 mr-1.5" />
            {runNow.isPending ? "Running…" : "Run now"}
          </Button>
          {!projectId && (
            <span className="text-xs text-muted-foreground">
              Select an app to enable manual runs.
            </span>
          )}
        </div>

        {status.data?.lastError && (
          <p className="text-xs text-rose-500">
            Last error: {status.data.lastError.message}
          </p>
        )}
      </CardContent>
    </Card>
  );
};

// ─────────────────────────────────────────────────────────────────────────
// Eval & quality (the #14 surface)
// ─────────────────────────────────────────────────────────────────────────

const EvalQualityCard: React.FC<{ projectId: number | null }> = ({
  projectId,
}) => {
  const { data: evalSet, isLoading } = useGeniusCoreEvalSet(projectId);
  const { data: scores = [] } = useGeniusCoreAdapterScores(projectId, {
    limit: 20,
  });
  const setEvalSet = useSetGeniusCoreEvalSet();
  const setRollback = useSetGeniusCoreRollbackThreshold();
  const { settings } = useSettings();

  const threshold = settings?.geniusCore?.adapterRollbackThreshold ?? 0.05;
  const [thresholdDraft, setThresholdDraft] = useState<number | null>(null);
  const currentThreshold = thresholdDraft ?? threshold;

  const [editorText, setEditorText] = useState<string>("");
  // Editor format: one prompt per line, separator "|>", keywords comma-separated.
  // Example:
  //   What is 2+2?|>4,four
  //   Name the planet we live on.|>Earth,earth
  React.useEffect(() => {
    if (!evalSet) {
      setEditorText("");
      return;
    }
    const lines = evalSet.prompts.map((p, i) => {
      const kws = (evalSet.expectedKeywords[i] ?? []).join(",");
      return `${p}|>${kws}`;
    });
    setEditorText(lines.join("\n"));
  }, [evalSet]);

  function parseEditor(): { prompts: string[]; expectedKeywords: string[][] } {
    const lines = editorText
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    const prompts: string[] = [];
    const expectedKeywords: string[][] = [];
    for (const line of lines) {
      const idx = line.indexOf("|>");
      if (idx === -1) {
        throw new Error(
          `Each line needs "|>" separator. Bad line: ${line.slice(0, 40)}…`,
        );
      }
      const prompt = line.slice(0, idx).trim();
      const kws = line
        .slice(idx + 2)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (!prompt) throw new Error("Empty prompt");
      if (kws.length === 0) throw new Error(`No keywords for: ${prompt}`);
      prompts.push(prompt);
      expectedKeywords.push(kws);
    }
    if (prompts.length === 0) throw new Error("Eval set is empty");
    return { prompts, expectedKeywords };
  }

  return (
    <Card className="lg:col-span-2">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Target className="h-5 w-5" /> Eval &amp; Quality
        </CardTitle>
        <CardDescription>
          Score every distilled adapter against a small project eval set.
          Regressions auto-rollback to the previous context slot.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {!projectId && (
          <p className="text-sm text-muted-foreground">
            Select an app to configure its eval set.
          </p>
        )}

        {projectId && (
          <>
            <div className="space-y-2">
              <Label className="text-sm">Auto-rollback threshold</Label>
              <p className="text-xs text-muted-foreground">
                Roll back when score drops by at least this much vs. baseline.
                0% disables rollback.
              </p>
              <div className="flex items-center gap-4">
                <Slider
                  value={[Math.round(currentThreshold * 100)]}
                  onValueChange={(v) => setThresholdDraft(v[0] / 100)}
                  min={0}
                  max={50}
                  step={1}
                  className="flex-1"
                />
                <span className="w-14 text-right text-sm font-mono">
                  {(currentThreshold * 100).toFixed(0)}%
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    setRollback.mutate(currentThreshold, {
                      onSuccess: () => setThresholdDraft(null),
                    })
                  }
                  disabled={
                    thresholdDraft === null || setRollback.isPending
                  }
                >
                  <Save className="h-4 w-4 mr-1.5" />
                  Save
                </Button>
              </div>
            </div>

            <div className="space-y-2">
              <Label className="text-sm">Eval prompts</Label>
              <p className="text-xs text-muted-foreground">
                One prompt per line. Format: <code>prompt|&gt;kw1,kw2</code>.
                Each prompt scores 1 if the response contains any keyword
                (case-insensitive), 0 otherwise.
              </p>
              <Textarea
                value={editorText}
                onChange={(e) => setEditorText(e.target.value)}
                rows={8}
                placeholder={`What is 2+2?|>4,four\nWho wrote Hamlet?|>Shakespeare`}
                className="font-mono text-xs"
                disabled={isLoading || setEvalSet.isPending}
              />
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  onClick={() => {
                    try {
                      const parsed = parseEditor();
                      setEvalSet.mutate({
                        projectId,
                        prompts: parsed.prompts,
                        expectedKeywords: parsed.expectedKeywords,
                      });
                    } catch (err) {
                      alert(
                        err instanceof Error ? err.message : String(err),
                      );
                    }
                  }}
                  disabled={setEvalSet.isPending}
                >
                  <Save className="h-4 w-4 mr-1.5" />
                  Save Eval Set
                </Button>
                {evalSet?.lastScore != null && (
                  <span className="text-xs text-muted-foreground">
                    Last score: {formatScore(evalSet.lastScore)} ·{" "}
                    {formatAgo(evalSet.lastEvaluatedAtMs)}
                  </span>
                )}
              </div>
            </div>

            <div className="space-y-2">
              <Label className="text-sm flex items-center gap-2">
                <History className="h-4 w-4" />
                Recent adapter scores
              </Label>
              {scores.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No evaluations recorded yet.
                </p>
              ) : (
                <div className="overflow-x-auto rounded-md border border-border/40">
                  <table className="w-full text-xs">
                    <thead className="bg-muted/40">
                      <tr>
                        <th className="px-3 py-2 text-left font-medium">
                          When
                        </th>
                        <th className="px-3 py-2 text-left font-medium">
                          Adapter
                        </th>
                        <th className="px-3 py-2 text-right font-medium">
                          Score
                        </th>
                        <th className="px-3 py-2 text-right font-medium">
                          Baseline
                        </th>
                        <th className="px-3 py-2 text-left font-medium">
                          Outcome
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {scores.map((row, i) => (
                        <tr
                          key={`${row.adapterId}-${row.evaluatedAtMs}-${i}`}
                          className="border-t border-border/40"
                        >
                          <td className="px-3 py-1.5 text-muted-foreground">
                            {formatAgo(row.evaluatedAtMs)}
                          </td>
                          <td className="px-3 py-1.5 font-mono">
                            {row.adapterId.slice(0, 10)}…
                          </td>
                          <td className="px-3 py-1.5 text-right font-mono">
                            {formatScore(row.score)}
                          </td>
                          <td className="px-3 py-1.5 text-right font-mono text-muted-foreground">
                            {formatScore(row.baselineScore)}
                          </td>
                          <td className="px-3 py-1.5">
                            <OutcomeBadge outcome={row.outcome} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
};

// ─────────────────────────────────────────────────────────────────────────
// Bits
// ─────────────────────────────────────────────────────────────────────────

const Stat: React.FC<{ label: string; children: React.ReactNode }> = ({
  label,
  children,
}) => (
  <div className="flex items-center justify-between gap-3">
    <span className="text-muted-foreground">{label}</span>
    <span className="text-right">{children}</span>
  </div>
);

const OutcomeBadge: React.FC<{
  outcome: "applied" | "rolled_back" | "rejected";
}> = ({ outcome }) => {
  const styles =
    outcome === "applied"
      ? "bg-emerald-500/10 text-emerald-500 border-emerald-500/30"
      : outcome === "rolled_back"
        ? "bg-amber-500/10 text-amber-500 border-amber-500/30"
        : "bg-rose-500/10 text-rose-500 border-rose-500/30";
  const Icon =
    outcome === "applied"
      ? HardDrive
      : outcome === "rolled_back"
        ? RotateCcw
        : Cpu;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide",
        styles,
      )}
    >
      <Icon className="h-3 w-3" />
      {outcome.replace("_", " ")}
    </span>
  );
};
