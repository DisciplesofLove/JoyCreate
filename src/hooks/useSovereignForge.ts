/**
 * Sovereign Forge hooks — TanStack Query bindings for the Radicle / Whitehat
 * IPC surface exposed by `src/ipc/sovereign_client.ts`.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import SovereignClient, {
  type AddTrustedDidParams,
  type AuditResult,
  type CloneRepoParams,
  type CreateIdentityParams,
  type DownloadModelParams,
  type ForkLineageNode,
  type PublishModelParams,
  type PublishRepoParams,
  type RadicleNodeStatus,
  type RadicleRepoRow,
  type RadicleRepoSummary,
  type RadicleSeedPreset,
  type RadicleSeedSession,
  type RadicleSelf,
  type RadicleTrustedDidRow,
  type RegisterForkParams,
  type SetBaseTokenParams,
  type SovereignModelRow,
  type SyncRepoParams,
  type WhitehatAnchorLogRow,
} from "@/ipc/sovereign_client";

const client = () => SovereignClient.getInstance();

const QK = {
  nodeStatus: ["radicle", "node", "status"] as const,
  self: ["radicle", "self"] as const,
  hasIdentity: ["radicle", "identity", "has"] as const,
  repos: ["radicle", "repos"] as const,
  peers: (rid: string) => ["radicle", "peers", rid] as const,
  trust: ["radicle", "trust"] as const,
  auditHistory: (rid: string) => ["radicle", "audit", "history", rid] as const,
  models: ["sovereign-models", "list"] as const,
  model: (cid: string) => ["sovereign-models", "get", cid] as const,
  forkRoots: ["sovereign-fork", "roots"] as const,
  forkChildren: (rid: string) => ["sovereign-fork", "children", rid] as const,
  forkLineage: (rid: string) => ["sovereign-fork", "lineage", rid] as const,
  seedPresets: ["radicle", "seeds", "presets"] as const,
  seedSessions: ["radicle", "seeds", "sessions"] as const,
};

// ── Reads ────────────────────────────────────────────────────────────────────

export function useRadicleNodeStatus() {
  return useQuery<RadicleNodeStatus>({
    queryKey: QK.nodeStatus,
    queryFn: () => client().nodeStatus(),
    refetchInterval: 15000,
    staleTime: 5000,
  });
}

export function useRadicleSelf() {
  return useQuery<RadicleSelf | null>({
    queryKey: QK.self,
    queryFn: () => client().getSelf(),
    staleTime: 60_000,
  });
}

export function useHasRadicleIdentity() {
  return useQuery<boolean>({
    queryKey: QK.hasIdentity,
    queryFn: () => client().hasIdentity(),
    staleTime: 60_000,
  });
}

export function useRadicleRepos() {
  return useQuery<{
    registered: RadicleRepoRow[];
    node: RadicleRepoSummary[];
  }>({
    queryKey: QK.repos,
    queryFn: () => client().listRepos(),
    refetchInterval: 30_000,
  });
}

export function useRadiclePeers(rid: string | undefined) {
  return useQuery<string[]>({
    queryKey: QK.peers(rid ?? ""),
    queryFn: () => client().repoPeers(rid as string),
    enabled: !!rid,
    refetchInterval: 30_000,
  });
}

export function useTrustedDids() {
  return useQuery<RadicleTrustedDidRow[]>({
    queryKey: QK.trust,
    queryFn: () => client().listTrustedDids(),
    staleTime: 60_000,
  });
}

export function useAuditHistory(rid: string | undefined) {
  return useQuery<WhitehatAnchorLogRow[]>({
    queryKey: QK.auditHistory(rid ?? ""),
    queryFn: () => client().auditHistory(rid as string),
    enabled: !!rid,
  });
}

// ── Writes ───────────────────────────────────────────────────────────────────

export function useCreateRadicleIdentity() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (params: CreateIdentityParams) => client().createIdentity(params),
    onSuccess: (self) => {
      toast.success(`Radicle identity created: ${self.alias ?? self.did}`);
      qc.invalidateQueries({ queryKey: QK.self });
      qc.invalidateQueries({ queryKey: QK.hasIdentity });
    },
    onError: (err: unknown) =>
      toast.error(`Failed to create identity: ${(err as Error).message}`),
  });
}

export function usePublishToRadicle() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (params: PublishRepoParams) => client().publishRepo(params),
    onSuccess: (res) => {
      toast.success(`Repo published: ${res.rid}`);
      qc.invalidateQueries({ queryKey: QK.repos });
    },
    onError: (err: unknown) =>
      toast.error(`Publish failed: ${(err as Error).message}`),
  });
}

export function useCloneFromRadicle() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (params: CloneRepoParams) => client().cloneRepo(params),
    onSuccess: (res) => {
      toast.success(`Cloned ${res.rid} to ${res.targetDir}`);
      qc.invalidateQueries({ queryKey: QK.repos });
    },
    onError: (err: unknown) =>
      toast.error(`Clone failed: ${(err as Error).message}`),
  });
}

export function useSyncRadicleRepo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (params: SyncRepoParams) => client().syncRepo(params),
    onSuccess: () => {
      toast.success("Repo synced");
      qc.invalidateQueries({ queryKey: QK.repos });
    },
    onError: (err: unknown) =>
      toast.error(`Sync failed: ${(err as Error).message}`),
  });
}

export function useAddTrustedDid() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (params: AddTrustedDidParams) => client().addTrustedDid(params),
    onSuccess: () => qc.invalidateQueries({ queryKey: QK.trust }),
    onError: (err: unknown) =>
      toast.error(`Add trust failed: ${(err as Error).message}`),
  });
}

export function useRemoveTrustedDid() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (did: string) => client().removeTrustedDid(did),
    onSuccess: () => qc.invalidateQueries({ queryKey: QK.trust }),
    onError: (err: unknown) =>
      toast.error(`Remove trust failed: ${(err as Error).message}`),
  });
}

export function useRunAudit() {
  const qc = useQueryClient();
  return useMutation<AuditResult, Error, number>({
    mutationFn: (appId: number) => client().runAudit(appId),
    onSuccess: (result) => {
      if (result.blocked) {
        toast.error(`Audit BLOCKED: ${result.findings.length} finding(s)`);
      } else if (result.findings.some((f) => f.severity === "warn")) {
        toast.warning(`Audit passed with warnings`);
      } else {
        toast.success(`Audit passed`);
      }
      qc.invalidateQueries({ queryKey: ["radicle", "audit"] });
    },
    onError: (err) => toast.error(`Audit failed: ${err.message}`),
  });
}

// ── Sovereign Models (Phase 5) ───────────────────────────────────────────────

export function useSovereignModels() {
  return useQuery<SovereignModelRow[]>({
    queryKey: QK.models,
    queryFn: () => client().listModels(),
    staleTime: 30_000,
  });
}

export function useSovereignModel(cid: string | undefined) {
  return useQuery<SovereignModelRow>({
    queryKey: QK.model(cid ?? ""),
    queryFn: () => client().getModel(cid as string),
    enabled: !!cid,
  });
}

export function usePublishSovereignModel() {
  const qc = useQueryClient();
  return useMutation<SovereignModelRow, Error, PublishModelParams>({
    mutationFn: (params) => client().publishModel(params),
    onSuccess: (row) => {
      toast.success(
        `Model published: ${row.modelName}@${row.version} (CID ${row.cid.slice(0, 12)}…)`,
      );
      qc.invalidateQueries({ queryKey: QK.models });
    },
    onError: (err) => toast.error(`Publish model failed: ${err.message}`),
  });
}

export function useDownloadSovereignModel() {
  return useMutation<{ bytes: number; sha256: string }, Error, DownloadModelParams>({
    mutationFn: (params) => client().downloadModel(params),
    onSuccess: (res) =>
      toast.success(`Model downloaded (${res.bytes.toLocaleString()} bytes)`),
    onError: (err) => toast.error(`Download failed: ${err.message}`),
  });
}

export function usePinSovereignModel() {
  const qc = useQueryClient();
  return useMutation<{ pinnedLocally: true }, Error, string>({
    mutationFn: (cid) => client().pinModel(cid),
    onSuccess: () => {
      toast.success("Model pinned locally");
      qc.invalidateQueries({ queryKey: QK.models });
    },
    onError: (err) => toast.error(`Pin failed: ${err.message}`),
  });
}

export function useUnpinSovereignModel() {
  const qc = useQueryClient();
  return useMutation<{ pinnedLocally: false }, Error, string>({
    mutationFn: (cid) => client().unpinModel(cid),
    onSuccess: () => {
      toast.success("Model unpinned");
      qc.invalidateQueries({ queryKey: QK.models });
    },
    onError: (err) => toast.error(`Unpin failed: ${err.message}`),
  });
}

export function useVerifySovereignModelAnchor() {
  return useMutation<
    { verified: boolean; celestiaHeight: number | null; celestiaCommitment: string | null; reason?: string },
    Error,
    string
  >({
    mutationFn: (cid) => client().verifyModelAnchor(cid),
    onSuccess: (res) => {
      if (res.verified) {
        toast.success(`Anchor verified at Celestia height ${res.celestiaHeight}`);
      } else {
        toast.warning(`Anchor not verified: ${res.reason ?? "unknown"}`);
      }
    },
    onError: (err) => toast.error(`Verify failed: ${err.message}`),
  });
}

export function useDeleteSovereignModel() {
  const qc = useQueryClient();
  return useMutation<{ deleted: true }, Error, string>({
    mutationFn: (cid) => client().deleteModel(cid),
    onSuccess: () => {
      toast.success("Model deleted");
      qc.invalidateQueries({ queryKey: QK.models });
    },
    onError: (err) => toast.error(`Delete failed: ${err.message}`),
  });
}

// ── Sovereign Forks (Phase 6) ────────────────────────────────────────────────

export function useForkRoots() {
  return useQuery<RadicleRepoRow[]>({
    queryKey: QK.forkRoots,
    queryFn: () => client().listForkRoots(),
    staleTime: 30_000,
  });
}

export function useForkChildren(parentRid: string | undefined) {
  return useQuery<RadicleRepoRow[]>({
    queryKey: QK.forkChildren(parentRid ?? ""),
    queryFn: () => client().listForkChildren(parentRid as string),
    enabled: !!parentRid,
  });
}

export function useForkLineage(rid: string | undefined) {
  return useQuery<ForkLineageNode[]>({
    queryKey: QK.forkLineage(rid ?? ""),
    queryFn: () => client().getForkLineage(rid as string),
    enabled: !!rid,
  });
}

export function useSetBaseToken() {
  const qc = useQueryClient();
  return useMutation<RadicleRepoRow, Error, SetBaseTokenParams>({
    mutationFn: (params) => client().setBaseToken(params),
    onSuccess: () => {
      toast.success("Base edition token id linked");
      qc.invalidateQueries({ queryKey: QK.repos });
      qc.invalidateQueries({ queryKey: ["sovereign-fork"] });
    },
    onError: (err) => toast.error(`Set base token failed: ${err.message}`),
  });
}

export function useRegisterFork() {
  const qc = useQueryClient();
  return useMutation<RadicleRepoRow, Error, RegisterForkParams>({
    mutationFn: (params) => client().registerFork(params),
    onSuccess: (row) => {
      toast.success(`Fork registered: ${row.name} → parent ${row.parentRid}`);
      qc.invalidateQueries({ queryKey: QK.repos });
      qc.invalidateQueries({ queryKey: ["sovereign-fork"] });
    },
    onError: (err) => toast.error(`Register fork failed: ${err.message}`),
  });
}

// ── Seed Nodes ───────────────────────────────────────────────────────────────

export function useSeedPresets() {
  return useQuery<RadicleSeedPreset[]>({
    queryKey: QK.seedPresets,
    queryFn: () => client().listSeedPresets(),
    staleTime: Infinity,
  });
}

export function useSeedSessions() {
  return useQuery<RadicleSeedSession[]>({
    queryKey: QK.seedSessions,
    queryFn: () => client().listSeedSessions(),
    refetchInterval: 15_000,
  });
}

export function useConnectSeed() {
  const qc = useQueryClient();
  return useMutation<{ ok: true }, Error, string>({
    mutationFn: (address) => client().connectSeed(address),
    onSuccess: () => {
      toast.success("Seed connection initiated");
      qc.invalidateQueries({ queryKey: QK.seedSessions });
      qc.invalidateQueries({ queryKey: QK.nodeStatus });
    },
    onError: (err) => toast.error(`Connect failed: ${err.message}`),
  });
}

export function useDisconnectSeed() {
  const qc = useQueryClient();
  return useMutation<{ ok: true }, Error, string>({
    mutationFn: (nid) => client().disconnectSeed(nid),
    onSuccess: () => {
      toast.success("Disconnected");
      qc.invalidateQueries({ queryKey: QK.seedSessions });
    },
    onError: (err) => toast.error(`Disconnect failed: ${err.message}`),
  });
}

export function useSeedRepo() {
  const qc = useQueryClient();
  return useMutation<{ ok: true }, Error, { rid: string; scope?: "all" | "trusted" }>({
    mutationFn: ({ rid, scope }) => client().seedRepo(rid, scope),
    onSuccess: () => {
      toast.success("Seeding repo");
      qc.invalidateQueries({ queryKey: QK.repos });
    },
    onError: (err) => toast.error(`Seed repo failed: ${err.message}`),
  });
}

export function useUnseedRepo() {
  const qc = useQueryClient();
  return useMutation<{ ok: true }, Error, string>({
    mutationFn: (rid) => client().unseedRepo(rid),
    onSuccess: () => {
      toast.success("Stopped seeding");
      qc.invalidateQueries({ queryKey: QK.repos });
    },
    onError: (err) => toast.error(`Unseed failed: ${err.message}`),
  });
}
