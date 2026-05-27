import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Database,
  Server,
  Search,
  HardDrive,
  ExternalLink,
  CheckCircle2,
  Loader2,
  Settings,
} from "lucide-react";
import { IpcClient } from "@/ipc/ipc_client";
import { useLoadApp } from "@/hooks/useLoadApp";
import {
  DEFAULT_DATA_LAYER_CONFIG,
  deriveLegacyDataLayerConfig,
  type BlobStorageKind,
  type DataLayerConfig,
  type DataLayerKind,
  type DataLayerStatus,
  type ProviderReadiness,
  type ReadIndexKind,
  type ServerRuntimeKind,
} from "@/shared/data_layer_types";

interface ProviderOption<T extends string> {
  value: T;
  label: string;
  hint: string;
}

const PRIMARY_STORES: ProviderOption<DataLayerKind>[] = [
  { value: "none", label: "None", hint: "Static / client-only" },
  { value: "supabase", label: "Supabase", hint: "Postgres + Auth (hybrid web2)" },
  { value: "tableland", label: "Tableland", hint: "Onchain SQL (EVM)" },
  { value: "ceramic", label: "Ceramic", hint: "DID streams (ComposeDB)" },
  { value: "gundb", label: "GunDB", hint: "Local-first p2p mesh" },
  { value: "orbitdb", label: "OrbitDB", hint: "CRDT over IPFS pubsub" },
  { value: "weavedb", label: "WeaveDB", hint: "Arweave permanent NoSQL" },
];

const SERVER_RUNTIMES: ProviderOption<ServerRuntimeKind>[] = [
  { value: "none", label: "None", hint: "Pure client-side" },
  { value: "supabase-edge", label: "Supabase Edge", hint: "Deno edge functions" },
  { value: "vercel-functions", label: "Vercel Functions", hint: "Next.js API / Edge" },
  { value: "cloudflare-workers", label: "Cloudflare Workers", hint: "Global edge + KV/D1" },
  { value: "railway", label: "Railway", hint: "Container PaaS" },
  { value: "render", label: "Render", hint: "Container PaaS" },
  { value: "fly-io", label: "Fly.io", hint: "Global container runtime" },
  { value: "aws-lambda", label: "AWS Lambda", hint: "Mature serverless" },
];

const READ_INDEXES: ProviderOption<ReadIndexKind>[] = [
  { value: "none", label: "None", hint: "Direct chain reads" },
  { value: "goldsky", label: "Goldsky", hint: "Hosted subgraphs (built-in)" },
  { value: "thegraph", label: "The Graph", hint: "Decentralized subgraphs" },
];

const BLOB_STORES: ProviderOption<BlobStorageKind>[] = [
  { value: "none", label: "None", hint: "No blob storage" },
  { value: "supabase-storage", label: "Supabase Storage", hint: "S3-compatible buckets" },
  { value: "ipfs-4everland", label: "4everland (IPFS)", hint: "Pinned IPFS gateway" },
  { value: "ipfs-helia", label: "Helia (IPFS)", hint: "Embedded in-process node" },
  { value: "arweave", label: "Arweave", hint: "Permanent storage" },
  { value: "celestia", label: "Celestia", hint: "Data availability layer" },
];

type Knob = "primaryStore" | "serverRuntime" | "readIndex" | "blobStorage";

export function DataLayerConnector({ appId }: { appId: number }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { app, refreshApp } = useLoadApp(appId);

  const effectiveConfig: DataLayerConfig = useMemo(() => {
    if (app?.dataLayerConfig) {
      try {
        const parsed =
          typeof app.dataLayerConfig === "string"
            ? JSON.parse(app.dataLayerConfig)
            : app.dataLayerConfig;
        return { ...DEFAULT_DATA_LAYER_CONFIG, ...parsed };
      } catch {
        // fall through to legacy
      }
    }
    return deriveLegacyDataLayerConfig({
      supabaseProjectId: app?.supabaseProjectId,
      neonProjectId: app?.neonProjectId,
    });
  }, [app?.dataLayerConfig, app?.supabaseProjectId, app?.neonProjectId]);

  const { data: status, isLoading } = useQuery<DataLayerStatus>({
    queryKey: ["data-layer-status", appId, effectiveConfig],
    queryFn: () =>
      IpcClient.getInstance().getDataLayerStatus({
        appId,
        config: effectiveConfig,
      }),
    enabled: !!appId,
  });

  const {
    mutate: persistConfig,
    isPending: isSaving,
    variables: savingVars,
  } = useMutation({
    mutationFn: (next: DataLayerConfig) =>
      IpcClient.getInstance().setDataLayerConfig({ appId, config: next }),
    onSuccess: async () => {
      await refreshApp();
      queryClient.invalidateQueries({ queryKey: ["data-layer-status", appId] });
    },
    onError: (e: unknown) => {
      toast.error(
        `Failed to save data layer: ${e instanceof Error ? e.message : String(e)}`,
      );
    },
  });

  const select = <T extends string>(knob: Knob, value: T) => {
    const next: DataLayerConfig = {
      ...effectiveConfig,
      [knob]: value,
    } as DataLayerConfig;
    persistConfig(next);
  };

  const goManage = (readiness: ProviderReadiness | undefined) => {
    if (!readiness) return;
    if (readiness.manageUrl) {
      const [path, hash] = readiness.manageUrl.split("#");
      navigate({ to: path || "/settings", hash: hash || undefined });
      return;
    }
    if (readiness.docsUrl) {
      IpcClient.getInstance().openExternalUrl(readiness.docsUrl);
    }
  };

  return (
    <Card className="mt-1">
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Data + Backend Layer</CardTitle>
        <CardDescription>
          Pick where this app's data, server, index, and blobs live. Choose a
          fully hosted web2 stack, a hybrid mix, or a fully onchain stack.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <KnobBlock
          icon={<Database className="h-4 w-4" />}
          title="Primary store"
          activeValue={effectiveConfig.primaryStore}
          options={PRIMARY_STORES}
          providers={status?.providers.primaryStore}
          activeReadiness={status?.active.primaryStore}
          isLoading={isLoading}
          savingValue={
            isSaving && savingVars?.primaryStore !== effectiveConfig.primaryStore
              ? savingVars?.primaryStore
              : undefined
          }
          onSelect={(v) => select("primaryStore", v)}
          onManage={goManage}
        />
        <KnobBlock
          icon={<Server className="h-4 w-4" />}
          title="Server runtime"
          activeValue={effectiveConfig.serverRuntime}
          options={SERVER_RUNTIMES}
          providers={status?.providers.serverRuntime}
          activeReadiness={status?.active.serverRuntime}
          isLoading={isLoading}
          savingValue={
            isSaving &&
            savingVars?.serverRuntime !== effectiveConfig.serverRuntime
              ? savingVars?.serverRuntime
              : undefined
          }
          onSelect={(v) => select("serverRuntime", v)}
          onManage={goManage}
        />
        <KnobBlock
          icon={<Search className="h-4 w-4" />}
          title="Read index"
          activeValue={effectiveConfig.readIndex}
          options={READ_INDEXES}
          providers={status?.providers.readIndex}
          activeReadiness={status?.active.readIndex}
          isLoading={isLoading}
          savingValue={
            isSaving && savingVars?.readIndex !== effectiveConfig.readIndex
              ? savingVars?.readIndex
              : undefined
          }
          onSelect={(v) => select("readIndex", v)}
          onManage={goManage}
        />
        <KnobBlock
          icon={<HardDrive className="h-4 w-4" />}
          title="Blob storage"
          activeValue={effectiveConfig.blobStorage}
          options={BLOB_STORES}
          providers={status?.providers.blobStorage}
          activeReadiness={status?.active.blobStorage}
          isLoading={isLoading}
          savingValue={
            isSaving && savingVars?.blobStorage !== effectiveConfig.blobStorage
              ? savingVars?.blobStorage
              : undefined
          }
          onSelect={(v) => select("blobStorage", v)}
          onManage={goManage}
        />

        <div className="flex justify-end pt-1">
          <Button
            variant="outline"
            size="sm"
            onClick={() => navigate({ to: "/settings", hash: "integrations" })}
            className="gap-1"
          >
            <Settings className="h-3.5 w-3.5" />
            Manage all integrations
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function KnobBlock<T extends string>(props: {
  icon: React.ReactNode;
  title: string;
  activeValue: T;
  options: ProviderOption<T>[];
  providers: Record<string, ProviderReadiness> | undefined;
  activeReadiness: ProviderReadiness | undefined;
  isLoading: boolean;
  savingValue: T | undefined;
  onSelect: (value: T) => void;
  onManage: (readiness: ProviderReadiness | undefined) => void;
}) {
  const {
    icon,
    title,
    activeValue,
    options,
    providers,
    activeReadiness,
    isLoading,
    savingValue,
    onSelect,
    onManage,
  } = props;
  const active = options.find((o) => o.value === activeValue) ?? options[0];
  const showConnect =
    active.value !== "none" && activeReadiness && !activeReadiness.configured;

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-muted-foreground shrink-0">{icon}</span>
          <span className="text-sm font-medium">{title}</span>
          <span className="text-xs text-muted-foreground truncate">
            · {active.label}
          </span>
          {active.value !== "none" && (
            <ReadinessBadge readiness={activeReadiness} isLoading={isLoading} />
          )}
        </div>
        {showConnect && (
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-2 text-xs gap-1"
            onClick={() => onManage(activeReadiness)}
          >
            Connect
            <ExternalLink className="h-3 w-3" />
          </Button>
        )}
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-1.5">
        {options.map((opt) => {
          const r = providers?.[opt.value];
          const isActive = opt.value === activeValue;
          const isSavingThis = savingValue === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => !isActive && !isSavingThis && onSelect(opt.value)}
              title={opt.hint}
              disabled={isSavingThis}
              className={`group text-left text-xs px-2 py-1.5 rounded border transition-colors ${
                isActive
                  ? "border-violet-500 bg-violet-50 dark:bg-violet-950/40"
                  : "border-border bg-muted/30 hover:bg-muted/60 cursor-pointer"
              } ${isSavingThis ? "opacity-60" : ""}`}
            >
              <div className="flex items-center gap-1.5">
                {isActive ? (
                  <CheckCircle2 className="h-3 w-3 text-violet-600 dark:text-violet-400 shrink-0" />
                ) : isSavingThis ? (
                  <Loader2 className="h-3 w-3 animate-spin shrink-0" />
                ) : (
                  <span className="h-3 w-3 shrink-0" />
                )}
                <span className="font-medium truncate">{opt.label}</span>
              </div>
              <div className="flex items-center justify-between mt-0.5 pl-4">
                <span className="text-[10px] text-muted-foreground truncate">
                  {opt.hint}
                </span>
                {opt.value !== "none" && (
                  <ReadinessBadge
                    readiness={r}
                    isLoading={isLoading}
                    compact
                  />
                )}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ReadinessBadge({
  readiness,
  isLoading,
  compact,
}: {
  readiness: ProviderReadiness | undefined;
  isLoading: boolean;
  compact?: boolean;
}) {
  if (isLoading && !readiness) {
    return <Skeleton className={compact ? "h-3 w-10" : "h-4 w-16"} />;
  }
  if (!readiness) {
    return null;
  }
  if (readiness.ready) {
    return (
      <Badge
        variant="secondary"
        className="bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300 h-4 px-1.5 text-[10px]"
      >
        Ready
      </Badge>
    );
  }
  if (readiness.configured) {
    return (
      <Badge
        variant="secondary"
        className="bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300 h-4 px-1.5 text-[10px]"
      >
        Configured
      </Badge>
    );
  }
  return (
    <Badge
      variant="outline"
      className="h-4 px-1.5 text-[10px] text-muted-foreground"
    >
      Setup
    </Badge>
  );
}
