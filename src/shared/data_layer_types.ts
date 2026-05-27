/**
 * Data + Backend Layer types.
 *
 * Models the four orthogonal "where does the data / runtime live?" knobs the
 * builder needs to know about so it can generate correct integration code,
 * prompts, deploy scripts, and readiness UI.
 *
 * Knob 5 (frontend host: vercel / fleek / ipfs / arweave) is already covered
 * by the deploy provider work and is NOT modelled here.
 *
 * This file is renderer-safe (no electron imports) so it can be shared
 * between main, preload, and renderer.
 */

// ── Knob 1: primary store (writes/queries live here) ────────────────────────
export type DataLayerKind =
  | "none" // localStorage / IndexedDB only — marketing or static
  | "supabase" // Postgres + Auth (hybrid web2)
  | "tableland" // onchain relational SQL (EVM)
  | "ceramic" // ComposeDB streams (DID-based)
  | "gundb" // local-first p2p mesh
  | "orbitdb" // CRDT over IPFS pubsub
  | "weavedb"; // Arweave-backed permanent NoSQL

// ── Knob 2: server runtime (where server code / cron / APIs run) ───────────
export type ServerRuntimeKind =
  | "none" // pure client-side
  | "supabase-edge" // Deno edge functions co-located with Supabase
  | "vercel-functions" // Next.js API routes / Edge Functions
  | "cloudflare-workers" // global edge with KV / D1 / Durable Objects
  | "railway" // container PaaS
  | "render" // container PaaS
  | "fly-io" // global container runtime
  | "aws-lambda"; // mature serverless functions

/** Derived runtime shape — used for prompt branching. */
export type ServerRuntimeShape = "edge" | "container" | "function" | "none";

// ── Knob 3: read index (optional, only meaningful for onchain primaries) ───
export type ReadIndexKind =
  | "none"
  | "goldsky" // existing client at src/lib/subgraph_client.ts
  | "thegraph"; // hosted/decentralized subgraphs

// ── Knob 4: blob storage (optional) ────────────────────────────────────────
export type BlobStorageKind =
  | "none"
  | "supabase-storage"
  | "ipfs-4everland"
  | "ipfs-helia" // embedded Helia node already wired in ipfs_pinner.ts
  | "arweave"
  | "celestia"; // data-availability layer via celestia_blob_service

/**
 * Full per-app data + backend config. Stored as JSON on `apps.dataLayerConfig`
 * with `primaryStore` and `serverRuntime` duplicated into dedicated columns
 * for cheap dashboard queries.
 */
export interface DataLayerConfig {
  primaryStore: DataLayerKind;
  serverRuntime: ServerRuntimeKind;
  readIndex: ReadIndexKind;
  blobStorage: BlobStorageKind;
  /** Free-form hints captured at scope time; refined by the builder mid-chat. */
  schemaNotes?: string;
  /** Onchain network slug (e.g. "polygon-amoy", "optimism") — for tableland/weavedb. */
  network?: string;
  /** Server runtime region hint (e.g. "us-east-1", "lhr") — for railway/render/fly. */
  serverRegion?: string;
  /** Env vars the server runtime needs (names only; values live in provider). */
  serverEnvVars?: string[];
  /** Supabase-specific add-on (only meaningful when primaryStore === "supabase"). */
  supabaseSync?: "none" | "powersync";
}

/** Status reported by main process per provider id. */
export interface ProviderReadiness {
  configured: boolean;
  ready: boolean;
  /** Short human explanation of current state. */
  hint?: string;
  /** Deep-link to in-app settings hash, e.g. `/settings#integrations`. */
  manageUrl?: string;
  /** External docs/install link if no in-app flow exists yet. */
  docsUrl?: string;
}

/** Aggregate status payload returned by `data-layer:status` IPC. */
export interface DataLayerStatus {
  /** Readiness of the currently-selected option for each knob. */
  active: {
    primaryStore: ProviderReadiness;
    serverRuntime: ProviderReadiness;
    readIndex: ProviderReadiness;
    blobStorage: ProviderReadiness;
  };
  /** Per-provider readiness so the UI can paint chips. */
  providers: {
    primaryStore: Record<DataLayerKind, ProviderReadiness>;
    serverRuntime: Record<ServerRuntimeKind, ProviderReadiness>;
    readIndex: Record<ReadIndexKind, ProviderReadiness>;
    blobStorage: Record<BlobStorageKind, ProviderReadiness>;
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────

export const DEFAULT_DATA_LAYER_CONFIG: DataLayerConfig = {
  primaryStore: "none",
  serverRuntime: "none",
  readIndex: "none",
  blobStorage: "none",
};

/** Smart-default config per Quick Start project type. */
export function defaultDataLayerFor(projectType: string | undefined): DataLayerConfig {
  switch (projectType) {
    case "website": // marketing
      return { ...DEFAULT_DATA_LAYER_CONFIG };
    case "app":
      return {
        primaryStore: "supabase",
        serverRuntime: "supabase-edge",
        readIndex: "none",
        blobStorage: "supabase-storage",
      };
    case "agent-ui":
      return {
        primaryStore: "supabase",
        serverRuntime: "railway",
        readIndex: "none",
        blobStorage: "supabase-storage",
      };
    case "game":
    case "ui-skin":
    case "mobile":
    case "desktop":
    default:
      return { ...DEFAULT_DATA_LAYER_CONFIG };
  }
}

/** Maps a server runtime to its execution shape. */
export function runtimeShape(kind: ServerRuntimeKind): ServerRuntimeShape {
  switch (kind) {
    case "none":
      return "none";
    case "supabase-edge":
    case "vercel-functions":
    case "cloudflare-workers":
      return "edge";
    case "railway":
    case "render":
    case "fly-io":
      return "container";
    case "aws-lambda":
      return "function";
  }
}

export function isWeb3Primary(kind: DataLayerKind): boolean {
  return kind === "tableland" || kind === "ceramic" || kind === "weavedb" || kind === "orbitdb";
}

export function requiresWallet(kind: DataLayerKind): boolean {
  return isWeb3Primary(kind);
}

export function isOfflineFirst(kind: DataLayerKind): boolean {
  return kind === "gundb" || kind === "orbitdb";
}

export function isPermanent(config: Pick<DataLayerConfig, "primaryStore" | "blobStorage">): boolean {
  return (
    config.primaryStore === "weavedb" ||
    config.blobStorage === "arweave" ||
    config.blobStorage === "celestia"
  );
}

/**
 * Legacy-compat: derive a `DataLayerConfig` from older `apps` rows that only
 * have `supabaseProjectId`. Called by chat handlers when `dataLayerConfig` is
 * null so existing apps keep working without a data migration.
 */
export function deriveLegacyDataLayerConfig(opts: {
  supabaseProjectId?: string | null;
  neonProjectId?: string | null;
}): DataLayerConfig {
  if (opts.supabaseProjectId) {
    return {
      primaryStore: "supabase",
      serverRuntime: "supabase-edge",
      readIndex: "none",
      blobStorage: "supabase-storage",
    };
  }
  if (opts.neonProjectId) {
    return {
      primaryStore: "supabase", // closest semantic match for prompt purposes
      serverRuntime: "none",
      readIndex: "none",
      blobStorage: "none",
    };
  }
  return { ...DEFAULT_DATA_LAYER_CONFIG };
}
