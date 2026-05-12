/**
 * Sovereign Forge Client — renderer-side IPC wrapper for the Radicle P2P
 * sidecar, Whitehat manifest tooling, and audit pipeline.
 *
 * Mirrors the channel surface registered in `src/ipc/handlers/radicle_handlers.ts`.
 */

import type { IpcRenderer } from "electron";

// =============================================================================
// TYPES (kept in sync with handler param/return types)
// =============================================================================

export interface RadicleSelf {
  did: string;
  nid: string;
  alias?: string;
}

export interface RadicleNodeStatus {
  running: boolean;
  alias?: string;
  peers?: number;
  raw?: string;
}

export interface RadicleRepoSummary {
  rid: string;
  name: string;
  description?: string;
  visibility?: string;
}

export interface RadicleRepoRow {
  id: number;
  rid: string;
  appId: number | null;
  name: string;
  defaultBranch: string;
  visibility: "public" | "private";
  creatorDid: string | null;
  whitehatPolicyHash: string | null;
  whitehatAnchorHeight: number | null;
  baseEditionTokenId: string | null;
  parentEditionTokenId: string | null;
  parentRid: string | null;
  lastSyncedAt: Date | null;
  peerCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface RadicleTrustedDidRow {
  did: string;
  label: string | null;
  trustLevel: "full" | "manual-review" | "blocked";
  addedAt: Date;
  notes: string | null;
}

export interface WhitehatAnchorLogRow {
  id: string;
  rid: string;
  eventType: "published" | "verified" | "rejected" | "drifted";
  signerDid: string;
  manifestHash: string;
  signature: string | null;
  celestiaHeight: number | null;
  celestiaTxHash: string | null;
  celestiaNamespace: string | null;
  celestiaCommitment: string | null;
  auditReportJson: unknown;
  anchoredAt: Date;
}

export interface CreateIdentityParams {
  alias: string;
  passphrase: string;
}

export interface PublishRepoParams {
  appId: number;
  name: string;
  description?: string;
  defaultBranch?: string;
  visibility?: "public" | "private";
  passphrase: string;
  whitehat?: {
    creatorDid: string;
    privateKeyHex: string;
    policy?: {
      allowedFileGlobs?: string[];
      disallowedFileGlobs?: string[];
      allowedIpcChannels?: string[];
      allowedMcpTools?: string[];
      dependencyPins?: string[];
      maxSizeMb?: number;
    };
  };
}

export interface CloneRepoParams {
  rid: string;
  targetDir?: string;
  registerAsAppName?: string;
  passphrase?: string;
}

export interface SyncRepoParams {
  appId?: number;
  cwd?: string;
  passphrase?: string;
}

export interface AddTrustedDidParams {
  did: string;
  label?: string;
  trustLevel: "full" | "manual-review" | "blocked";
  notes?: string;
}

export interface AuditFinding {
  tier: "static" | "llm";
  severity: "ok" | "warn" | "block";
  rule: string;
  message: string;
  file?: string;
}

export interface AuditResult {
  ok: boolean;
  blocked: boolean;
  trustLevel: "full" | "manual-review" | "blocked" | "unknown";
  staticReport: {
    signatureValid: boolean;
    manifestHashMatches: boolean;
    fileHashesMatch: boolean;
    driftedFiles: string[];
    newFiles: string[];
    removedFiles: string[];
    disallowedFiles: string[];
    findings: AuditFinding[];
  };
  llmReport?: {
    score: number;
    hijackProbability: number;
    reason: string;
    safe: boolean;
  };
  findings: AuditFinding[];
}

// ── Seed Nodes ─────────────────────────────────────────────────────────────────────────

export interface RadicleSeedPreset {
  id: string;
  name: string;
  address: string;
  description?: string;
  url?: string;
}

export interface RadicleSeedSession {
  nid: string;
  address?: string;
  status?: string;
  rawLine: string;
}

// ── Sovereign Models (Phase 5) ────────────────────────────────────────────────

export interface SovereignModelRow {
  id: number;
  cid: string;
  modelName: string;
  version: string;
  sha256: string;
  sizeBytes: number;
  publisherDid: string | null;
  celestiaHeight: number | null;
  celestiaCommitment: string | null;
  celestiaNamespace: string | null;
  pinnedLocally: boolean;
  metadataJson: Record<string, unknown> | null;
  createdAt: Date;
}

export interface PublishModelParams {
  filePath: string;
  modelName: string;
  version: string;
  publisherDid?: string;
  metadata?: Record<string, unknown>;
  anchorToCelestia?: boolean;
}

export interface DownloadModelParams {
  cid: string;
  outputPath: string;
  expectedSha256?: string;
}

// ── Sovereign Forks (Phase 6) ────────────────────────────────────────────────

export interface ForkLineageNode {
  rid: string;
  name: string;
  baseEditionTokenId: string | null;
  parentRid: string | null;
  parentEditionTokenId: string | null;
}

export interface RegisterForkParams {
  childRid: string;
  parentRid: string;
}

export interface SetBaseTokenParams {
  rid: string;
  baseEditionTokenId: string;
}

// =============================================================================
// CLIENT
// =============================================================================

class SovereignClient {
  private static instance: SovereignClient;
  private ipcRenderer: IpcRenderer;

  private constructor() {
    this.ipcRenderer = (window as unknown as {
      electron: { ipcRenderer: IpcRenderer };
    }).electron.ipcRenderer;
  }

  static getInstance(): SovereignClient {
    if (!SovereignClient.instance) {
      SovereignClient.instance = new SovereignClient();
    }
    return SovereignClient.instance;
  }

  // ── Node ────────────────────────────────────────────────────────────────────
  async nodeStatus(): Promise<RadicleNodeStatus> {
    return this.ipcRenderer.invoke("radicle:node:status");
  }

  // ── Identity ────────────────────────────────────────────────────────────────
  async createIdentity(params: CreateIdentityParams): Promise<RadicleSelf> {
    return this.ipcRenderer.invoke("radicle:identity:create", params);
  }
  async getSelf(): Promise<RadicleSelf | null> {
    return this.ipcRenderer.invoke("radicle:identity:get");
  }
  async hasIdentity(): Promise<boolean> {
    return this.ipcRenderer.invoke("radicle:identity:has");
  }

  // ── Repos ───────────────────────────────────────────────────────────────────
  async publishRepo(
    params: PublishRepoParams,
  ): Promise<{ rid: string; whitehatContentHash: string | null }> {
    return this.ipcRenderer.invoke("radicle:repo:publish", params);
  }

  async cloneRepo(
    params: CloneRepoParams,
  ): Promise<{ rid: string; targetDir: string; appId: number | null }> {
    return this.ipcRenderer.invoke("radicle:repo:clone", params);
  }

  async listRepos(): Promise<{
    registered: RadicleRepoRow[];
    node: RadicleRepoSummary[];
  }> {
    return this.ipcRenderer.invoke("radicle:repo:list");
  }

  async syncRepo(params: SyncRepoParams): Promise<{ ok: true }> {
    return this.ipcRenderer.invoke("radicle:repo:sync", params);
  }

  async repoPeers(rid: string): Promise<string[]> {
    return this.ipcRenderer.invoke("radicle:repo:peers", rid);
  }

  // ── Trust list ──────────────────────────────────────────────────────────────
  async listTrustedDids(): Promise<RadicleTrustedDidRow[]> {
    return this.ipcRenderer.invoke("radicle:trust:list");
  }
  async addTrustedDid(params: AddTrustedDidParams): Promise<{ ok: true }> {
    return this.ipcRenderer.invoke("radicle:trust:add", params);
  }
  async removeTrustedDid(did: string): Promise<{ ok: true }> {
    return this.ipcRenderer.invoke("radicle:trust:remove", did);
  }

  // ── Audit ───────────────────────────────────────────────────────────────────
  async runAudit(appId: number): Promise<AuditResult> {
    return this.ipcRenderer.invoke("radicle:audit:run", { appId });
  }
  async auditHistory(rid: string): Promise<WhitehatAnchorLogRow[]> {
    return this.ipcRenderer.invoke("radicle:audit:history", rid);
  }

  // ── Seed Nodes ──────────────────────────────────────────────────────────
  async listSeedPresets(): Promise<RadicleSeedPreset[]> {
    return this.ipcRenderer.invoke("radicle:seeds:presets");
  }
  async listSeedSessions(): Promise<RadicleSeedSession[]> {
    return this.ipcRenderer.invoke("radicle:seeds:list-sessions");
  }
  async connectSeed(address: string): Promise<{ ok: true }> {
    return this.ipcRenderer.invoke("radicle:seeds:connect", { address });
  }
  async disconnectSeed(nid: string): Promise<{ ok: true }> {
    return this.ipcRenderer.invoke("radicle:seeds:disconnect", { nid });
  }
  async seedRepo(rid: string, scope?: "all" | "trusted"): Promise<{ ok: true }> {
    return this.ipcRenderer.invoke("radicle:seeds:seed-repo", { rid, scope });
  }
  async unseedRepo(rid: string): Promise<{ ok: true }> {
    return this.ipcRenderer.invoke("radicle:seeds:unseed-repo", { rid });
  }

  // ── Sovereign Models (Phase 5: IPFS + Celestia) ────────────────────────────
  async publishModel(params: PublishModelParams): Promise<SovereignModelRow> {
    return this.ipcRenderer.invoke("sovereign-models:publish", params);
  }
  async listModels(): Promise<SovereignModelRow[]> {
    return this.ipcRenderer.invoke("sovereign-models:list");
  }
  async getModel(cid: string): Promise<SovereignModelRow> {
    return this.ipcRenderer.invoke("sovereign-models:get", { cid });
  }
  async downloadModel(
    params: DownloadModelParams,
  ): Promise<{ bytes: number; sha256: string }> {
    return this.ipcRenderer.invoke("sovereign-models:download", params);
  }
  async pinModel(cid: string): Promise<{ pinnedLocally: true }> {
    return this.ipcRenderer.invoke("sovereign-models:pin", { cid });
  }
  async unpinModel(cid: string): Promise<{ pinnedLocally: false }> {
    return this.ipcRenderer.invoke("sovereign-models:unpin", { cid });
  }
  async verifyModelAnchor(cid: string): Promise<{
    verified: boolean;
    celestiaHeight: number | null;
    celestiaCommitment: string | null;
    reason?: string;
  }> {
    return this.ipcRenderer.invoke("sovereign-models:verify-anchor", { cid });
  }
  async deleteModel(cid: string): Promise<{ deleted: true }> {
    return this.ipcRenderer.invoke("sovereign-models:delete", { cid });
  }

  // ── Sovereign Forks (Phase 6: ERC-1155 fork lineage) ──────────────────────────
  async setBaseToken(params: SetBaseTokenParams): Promise<RadicleRepoRow> {
    return this.ipcRenderer.invoke("sovereign-fork:set-base-token", params);
  }
  async registerFork(params: RegisterForkParams): Promise<RadicleRepoRow> {
    return this.ipcRenderer.invoke("sovereign-fork:register", params);
  }
  async listForkChildren(parentRid: string): Promise<RadicleRepoRow[]> {
    return this.ipcRenderer.invoke("sovereign-fork:list-children", { parentRid });
  }
  async getForkLineage(rid: string): Promise<ForkLineageNode[]> {
    return this.ipcRenderer.invoke("sovereign-fork:get-lineage", { rid });
  }
  async listForkRoots(): Promise<RadicleRepoRow[]> {
    return this.ipcRenderer.invoke("sovereign-fork:list-roots");
  }
}

export const sovereignClient = SovereignClient.getInstance.bind(SovereignClient);
export default SovereignClient;
