/**
 * /joy/blueprints — Sovereign Blueprint Engine console.
 *
 * Three panes:
 *   1. Composer — natural-language → YAML (calls blueprint:compose).
 *   2. Editor   — paste/edit YAML, validate, run.
 *   3. Runs     — list + detail of recent runs (auto-refreshes).
 *
 * All mutations go through `IpcClient.blueprint*` methods; reads use
 * TanStack Query so multiple panes stay in sync.
 */

import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { IpcClient } from "@/ipc/ipc_client";
import { showError } from "@/lib/toast";
import {
  BrainCircuit,
  Play,
  Loader2,
  RefreshCw,
  CheckCircle2,
  XCircle,
  Clock,
  AlertTriangle,
  Sparkles,
  Rocket,
} from "lucide-react";
import { PublishWizard } from "@/components/marketplace/PublishWizard";
import { usePublishBlueprint } from "@/hooks/use_publish_blueprint";
import { showSuccess } from "@/lib/toast";

// ---------------------------------------------------------------------------
// types (renderer-side mirror of @/lib/blueprint/run_store BlueprintRunRecord)
// ---------------------------------------------------------------------------

interface RunSummary {
  id: string;
  blueprintId: string;
  blueprintVersion: string;
  status: "pending" | "running" | "paused" | "succeeded" | "failed" | "aborted";
  currentNodeId: string | null;
  nodeState: Record<
    string,
    {
      status: "pending" | "running" | "succeeded" | "failed" | "skipped";
      output?: unknown;
      error?: string;
      startedAt?: number;
      completedAt?: number;
    }
  >;
  error: string | null;
  createdAt: string | Date;
  updatedAt: string | Date;
  completedAt: string | Date | null;
  yamlText: string | null;
}

interface AdapterEntry {
  name: string;
  channel: string;
  description: string;
  paramDocs?: string;
}

const RUNS_KEY = ["blueprint", "runs"] as const;
const ADAPTERS_KEY = ["blueprint", "adapters"] as const;

// ---------------------------------------------------------------------------
// page
// ---------------------------------------------------------------------------

export default function BlueprintsPage() {
  const qc = useQueryClient();
  const ipc = IpcClient.getInstance();

  const [intent, setIntent] = useState("");
  const [hints, setHints] = useState("");
  const [yaml, setYaml] = useState("");
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [publishOpen, setPublishOpen] = useState(false);
  const publishMut = usePublishBlueprint();

  // Auto-refresh runs every 2s while any run is non-terminal.
  const runsQuery = useQuery<RunSummary[]>({
    queryKey: RUNS_KEY,
    queryFn: async () => (await ipc.blueprintListRuns(50)) as RunSummary[],
    refetchInterval: (q) => {
      const data = q.state.data as RunSummary[] | undefined;
      const live = data?.some((r) => r.status === "pending" || r.status === "running");
      return live ? 2000 : 8000;
    },
  });

  const adaptersQuery = useQuery<AdapterEntry[]>({
    queryKey: ADAPTERS_KEY,
    queryFn: async () => ipc.blueprintListAdapters(),
    staleTime: 60_000,
  });

  const composeMut = useMutation({
    mutationFn: async (vars: { intent: string; hints?: string; autoRun?: boolean }) =>
      ipc.blueprintCompose(vars),
    onSuccess: (res) => {
      setYaml(res.yaml);
      if (res.runId) {
        setSelectedRunId(res.runId);
        qc.invalidateQueries({ queryKey: RUNS_KEY });
      }
    },
    onError: (err) => showError(err instanceof Error ? err : new Error(String(err))),
  });

  const runMut = useMutation({
    mutationFn: async (vars: { yamlText: string }) => ipc.blueprintRun(vars),
    onSuccess: (res) => {
      setSelectedRunId(res.runId);
      qc.invalidateQueries({ queryKey: RUNS_KEY });
    },
    onError: (err) => showError(err instanceof Error ? err : new Error(String(err))),
  });

  const validateMut = useMutation({
    mutationFn: async (yamlText: string) => ipc.blueprintValidate(yamlText),
    onError: (err) => showError(err instanceof Error ? err : new Error(String(err))),
  });

  const cancelMut = useMutation({
    mutationFn: async (runId: string) => ipc.blueprintCancel(runId),
    onSuccess: () => qc.invalidateQueries({ queryKey: RUNS_KEY }),
    onError: (err) => showError(err instanceof Error ? err : new Error(String(err))),
  });

  const selectedRun = useMemo(
    () => runsQuery.data?.find((r) => r.id === selectedRunId) ?? null,
    [runsQuery.data, selectedRunId],
  );

  // Hydrate YAML editor when a saved run is selected.
  useEffect(() => {
    if (selectedRun?.yamlText && !yaml.trim()) {
      setYaml(selectedRun.yamlText);
    }
  }, [selectedRun]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="container mx-auto p-6 space-y-6 max-w-7xl">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold flex items-center gap-2">
            <BrainCircuit className="h-8 w-8 text-violet-500" />
            Sovereign Blueprints
          </h1>
          <p className="text-muted-foreground">
            Natural-language → multi-step automation across browser, scraping,
            n8n, marketplace, and on-chain attestation. Every node is
            cryptographically verified by the Whitehat protocol.
          </p>
        </div>
      </header>

      <Tabs defaultValue="compose" className="w-full">
        <TabsList>
          <TabsTrigger value="compose">Compose</TabsTrigger>
          <TabsTrigger value="editor">YAML Editor</TabsTrigger>
          <TabsTrigger value="runs">Runs ({runsQuery.data?.length ?? 0})</TabsTrigger>
          <TabsTrigger value="adapters">Adapters ({adaptersQuery.data?.length ?? 0})</TabsTrigger>
        </TabsList>

        {/* ─── Compose ───────────────────────────────────────────────── */}
        <TabsContent value="compose" className="space-y-4 mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <Sparkles className="h-5 w-5 text-amber-500" />
                Describe what you want to automate
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <Textarea
                value={intent}
                onChange={(e) => setIntent(e.target.value)}
                placeholder="e.g. Curate real-time green hydrogen pricing from the top 5 industry sites, clean it, package as a verified ERC-1155 dataset, and list it on the Joy Marketplace."
                className="min-h-[120px] font-mono text-sm"
              />
              <Input
                value={hints}
                onChange={(e) => setHints(e.target.value)}
                placeholder="Optional hints: preferred adapters, target marketplace, attestation requirements…"
              />
              <div className="flex gap-2">
                <Button
                  onClick={() =>
                    composeMut.mutate({ intent, hints: hints || undefined, autoRun: false })
                  }
                  disabled={!intent.trim() || composeMut.isPending}
                >
                  {composeMut.isPending ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <BrainCircuit className="h-4 w-4 mr-2" />
                  )}
                  Compose
                </Button>
                <Button
                  variant="default"
                  onClick={() =>
                    composeMut.mutate({ intent, hints: hints || undefined, autoRun: true })
                  }
                  disabled={!intent.trim() || composeMut.isPending}
                >
                  {composeMut.isPending ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <Play className="h-4 w-4 mr-2" />
                  )}
                  Compose &amp; Run
                </Button>
              </div>
              {composeMut.data && (
                <div className="text-sm text-muted-foreground">
                  ✓ Composed{" "}
                  <code className="px-1 bg-muted rounded">{composeMut.data.blueprint?.id}</code>{" "}
                  ({composeMut.data.blueprint?.nodes?.length} nodes)
                  {composeMut.data.runId ? (
                    <>
                      {" "}— running as <code>{composeMut.data.runId.slice(0, 8)}</code>
                    </>
                  ) : null}
                </div>
              )}
            </CardContent>
          </Card>

          {yaml && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Composed YAML</CardTitle>
              </CardHeader>
              <CardContent>
                <pre className="text-xs whitespace-pre-wrap bg-muted p-3 rounded max-h-[400px] overflow-auto">
                  {yaml}
                </pre>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* ─── Editor ────────────────────────────────────────────────── */}
        <TabsContent value="editor" className="space-y-4 mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Blueprint YAML</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <Textarea
                value={yaml}
                onChange={(e) => setYaml(e.target.value)}
                placeholder="Paste or edit Blueprint YAML here…"
                className="min-h-[420px] font-mono text-xs"
              />
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  onClick={() => validateMut.mutate(yaml)}
                  disabled={!yaml.trim() || validateMut.isPending}
                >
                  Validate
                </Button>
                <Button
                  onClick={() => runMut.mutate({ yamlText: yaml })}
                  disabled={!yaml.trim() || runMut.isPending}
                >
                  {runMut.isPending ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <Play className="h-4 w-4 mr-2" />
                  )}
                  Run
                </Button>
                <Button
                  variant="ghost"
                  onClick={async () => {
                    try {
                      const res = await ipc.blueprintRehash(yaml);
                      setYaml(res.yaml);
                    } catch (err) {
                      showError(err instanceof Error ? err : new Error(String(err)));
                    }
                  }}
                  disabled={!yaml.trim()}
                >
                  Re-hash intents
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => setPublishOpen(true)}
                  disabled={!yaml.trim() || publishMut.isPending}
                  title="Publish this blueprint as a DropERC1155 NFT on JoyMarketplace"
                >
                  {publishMut.isPending ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <Rocket className="h-4 w-4 mr-2" />
                  )}
                  Publish to Marketplace
                </Button>
              </div>
              {validateMut.data && (
                <div className="text-sm text-emerald-600">
                  ✓ Valid: {validateMut.data.blueprint?.nodes?.length} nodes,{" "}
                  {validateMut.data.blueprint?.id} v{validateMut.data.blueprint?.version}
                </div>
              )}
              {validateMut.error && (
                <div className="text-sm text-red-600">{(validateMut.error as Error).message}</div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ─── Runs ──────────────────────────────────────────────────── */}
        <TabsContent value="runs" className="space-y-4 mt-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">Recent runs</h2>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => runsQuery.refetch()}
              disabled={runsQuery.isFetching}
            >
              {runsQuery.isFetching ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4 mr-2" />
              )}
              Refresh
            </Button>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div className="space-y-2 lg:col-span-1">
              {(runsQuery.data ?? []).map((r) => (
                <button
                  key={r.id}
                  onClick={() => setSelectedRunId(r.id)}
                  className={
                    "w-full text-left p-3 rounded-lg border transition " +
                    (r.id === selectedRunId
                      ? "border-violet-500 bg-violet-500/10"
                      : "border-border hover:bg-accent")
                  }
                >
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-xs">{r.id.slice(0, 8)}</span>
                    <StatusBadge status={r.status} />
                  </div>
                  <div className="text-sm font-medium truncate mt-1">{r.blueprintId}</div>
                  {r.currentNodeId && (
                    <div className="text-xs text-muted-foreground truncate">
                      @ {r.currentNodeId}
                    </div>
                  )}
                </button>
              ))}
              {(runsQuery.data ?? []).length === 0 && !runsQuery.isLoading && (
                <Card>
                  <CardContent className="p-6 text-sm text-muted-foreground text-center">
                    No runs yet. Compose a blueprint to get started.
                  </CardContent>
                </Card>
              )}
            </div>

            <div className="lg:col-span-2">
              {selectedRun ? (
                <RunDetail run={selectedRun} onCancel={() => cancelMut.mutate(selectedRun.id)} />
              ) : (
                <Card>
                  <CardContent className="p-6 text-sm text-muted-foreground text-center">
                    Select a run to see details.
                  </CardContent>
                </Card>
              )}
            </div>
          </div>
        </TabsContent>

        {/* ─── Adapters catalog ──────────────────────────────────────── */}
        <TabsContent value="adapters" className="space-y-2 mt-4">
          <p className="text-sm text-muted-foreground">
            Built-in adapters available to every blueprint. Each one hashes its
            channel + description into the Whitehat intent gate.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {(adaptersQuery.data ?? []).map((a) => (
              <Card key={a.name}>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-mono">{a.name}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2 text-xs">
                  <div className="text-muted-foreground">{a.description}</div>
                  <div>
                    <span className="text-muted-foreground">channel:</span>{" "}
                    <code className="px-1 bg-muted rounded">{a.channel}</code>
                  </div>
                  {a.paramDocs && (
                    <div>
                      <span className="text-muted-foreground">params:</span>{" "}
                      <code className="px-1 bg-muted rounded">{a.paramDocs}</code>
                    </div>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        </TabsContent>
      </Tabs>

      <PublishWizard
        open={publishOpen}
        onOpenChange={setPublishOpen}
        assetType="blueprint"
        sourceId={`bp-${Date.now()}`}
        defaultName="My Sovereign Blueprint"
        defaultDescription="A multi-step automation blueprint composed in JoyCreate."
        defaultCategory="ai-workflow"
        isPublishing={publishMut.isPending}
        onPublish={(payload) =>
          publishMut.mutate(
            {
              ...payload,
              metadata: {
                ...payload.metadata,
                yamlText: yaml,
                kind: "blueprint",
              },
            },
            {
              onSuccess: (res) => {
                setPublishOpen(false);
                showSuccess(
                  res.assetId
                    ? `Blueprint published — token #${res.assetId}`
                    : "Blueprint publish queued",
                );
              },
            },
          )
        }
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function StatusBadge({ status }: { status: RunSummary["status"] }): JSX.Element {
  const map: Record<RunSummary["status"], { icon: JSX.Element; cls: string; label: string }> = {
    pending: { icon: <Clock className="h-3 w-3" />, cls: "bg-zinc-500/15 text-zinc-600", label: "pending" },
    running: { icon: <Loader2 className="h-3 w-3 animate-spin" />, cls: "bg-blue-500/15 text-blue-600", label: "running" },
    paused: { icon: <Clock className="h-3 w-3" />, cls: "bg-amber-500/15 text-amber-600", label: "paused" },
    succeeded: { icon: <CheckCircle2 className="h-3 w-3" />, cls: "bg-emerald-500/15 text-emerald-600", label: "succeeded" },
    failed: { icon: <XCircle className="h-3 w-3" />, cls: "bg-red-500/15 text-red-600", label: "failed" },
    aborted: { icon: <AlertTriangle className="h-3 w-3" />, cls: "bg-orange-500/15 text-orange-600", label: "aborted" },
  };
  const m = map[status];
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs ${m.cls}`}>
      {m.icon}
      {m.label}
    </span>
  );
}

function RunDetail({
  run,
  onCancel,
}: {
  run: RunSummary;
  onCancel: () => void;
}): JSX.Element {
  const live = run.status === "pending" || run.status === "running";
  const nodes = Object.entries(run.nodeState ?? {});

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <span className="font-mono text-xs">{run.id.slice(0, 8)}</span>
            <StatusBadge status={run.status} />
          </CardTitle>
          {live && (
            <Button size="sm" variant="destructive" onClick={onCancel}>
              Cancel
            </Button>
          )}
        </div>
        <div className="text-xs text-muted-foreground">
          {run.blueprintId} v{run.blueprintVersion}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {run.error && (
          <div className="text-sm text-red-600 bg-red-500/10 p-2 rounded">{run.error}</div>
        )}

        <div>
          <h4 className="text-sm font-medium mb-2">Nodes ({nodes.length})</h4>
          <div className="space-y-2">
            {nodes.map(([id, state]) => (
              <div
                key={id}
                className="flex items-start justify-between gap-2 p-2 rounded border text-xs"
              >
                <div className="flex-1 min-w-0">
                  <div className="font-mono font-medium">{id}</div>
                  {state.error && (
                    <div className="text-red-600 truncate">{state.error}</div>
                  )}
                  {state.output != null && state.status === "succeeded" && (
                    <pre className="mt-1 text-[10px] text-muted-foreground line-clamp-3">
                      {typeof state.output === "string"
                        ? state.output
                        : JSON.stringify(state.output, null, 2)}
                    </pre>
                  )}
                </div>
                <Badge variant="secondary">{state.status}</Badge>
              </div>
            ))}
            {nodes.length === 0 && (
              <div className="text-xs text-muted-foreground">No node state yet.</div>
            )}
          </div>
        </div>

        {run.yamlText && (
          <details className="text-xs">
            <summary className="cursor-pointer text-muted-foreground">YAML</summary>
            <pre className="mt-2 p-2 bg-muted rounded whitespace-pre-wrap max-h-[300px] overflow-auto">
              {run.yamlText}
            </pre>
          </details>
        )}
      </CardContent>
    </Card>
  );
}
