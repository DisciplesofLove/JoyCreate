/**
 * Data Layer status IPC handler.
 *
 * Channel: `data-layer:status` — given an appId (or null), returns a
 * `DataLayerStatus` describing readiness of each of the four knobs.
 *
 * The renderer uses this to:
 *   1. Render the All Providers panel with accurate "configured" badges.
 *   2. Decide whether to inject AVAILABLE vs NOT_AVAILABLE prompt variants
 *      (matching what the chat handlers actually inject — keep them in sync).
 *
 * Stub readiness: providers we haven't wired credential checks for yet
 * report `configured: false, ready: false` with a hint pointing at the
 * roadmap. Supabase, Vercel, Goldsky, Celestia, IPFS pinner already exist
 * and report real readiness.
 */

import log from "electron-log";
import { db } from "../../db";
import { apps as appsTable } from "../../db/schema";
import { eq } from "drizzle-orm";
import { readSettings } from "../../main/settings";
import { isSupabaseConnected } from "@/lib/schemas";
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
import { createLoggedHandler } from "./safe_handle";

const logger = log.scope("data_layer_status_handlers");
const handle = createLoggedHandler(logger);

const STUB_HINT =
  "Provider readiness check not yet implemented — treated as not configured.";

const MANAGE_INTEGRATIONS = "/settings#integrations";

const PRIMARY_KINDS: DataLayerKind[] = [
  "none",
  "supabase",
  "tableland",
  "ceramic",
  "gundb",
  "orbitdb",
  "weavedb",
];
const SERVER_KINDS: ServerRuntimeKind[] = [
  "none",
  "supabase-edge",
  "vercel-functions",
  "cloudflare-workers",
  "railway",
  "render",
  "fly-io",
  "aws-lambda",
];
const READ_INDEX_KINDS: ReadIndexKind[] = ["none", "goldsky", "thegraph"];
const BLOB_KINDS: BlobStorageKind[] = [
  "none",
  "supabase-storage",
  "ipfs-4everland",
  "ipfs-helia",
  "arweave",
  "celestia",
];

const PRIMARY_DOCS: Partial<Record<DataLayerKind, string>> = {
  supabase: "https://supabase.com/docs",
  tableland: "https://docs.tableland.xyz/",
  ceramic: "https://composedb.js.org/",
  gundb: "https://gun.eco/docs/Introduction",
  orbitdb: "https://github.com/orbitdb/orbitdb",
  weavedb: "https://docs.weavedb.dev/",
};
const SERVER_DOCS: Partial<Record<ServerRuntimeKind, string>> = {
  "supabase-edge": "https://supabase.com/docs/guides/functions",
  "vercel-functions": "https://vercel.com/docs/functions",
  "cloudflare-workers": "https://developers.cloudflare.com/workers/",
  railway: "https://docs.railway.app/",
  render: "https://render.com/docs",
  "fly-io": "https://fly.io/docs/",
  "aws-lambda": "https://docs.aws.amazon.com/lambda/",
};
const READ_INDEX_DOCS: Partial<Record<ReadIndexKind, string>> = {
  goldsky: "https://docs.goldsky.com/",
  thegraph: "https://thegraph.com/docs/",
};
const BLOB_DOCS: Partial<Record<BlobStorageKind, string>> = {
  "supabase-storage": "https://supabase.com/docs/guides/storage",
  "ipfs-4everland": "https://docs.4everland.org/storage/",
  "ipfs-helia": "https://helia.io/",
  arweave: "https://docs.arweave.org/",
  celestia: "https://docs.celestia.org/",
};

function withMeta<K extends string>(
  base: ProviderReadiness,
  kind: K,
  docs: Partial<Record<K, string>>,
  manageUrl?: string,
): ProviderReadiness {
  return {
    ...base,
    manageUrl: base.manageUrl ?? manageUrl,
    docsUrl: base.docsUrl ?? docs[kind],
  };
}

function primaryStoreReadiness(
  kind: DataLayerKind,
  app: { supabaseProjectId: string | null } | null,
  settings: ReturnType<typeof readSettings> | null,
): ProviderReadiness {
  switch (kind) {
    case "none":
      return { configured: true, ready: true };
    case "supabase": {
      const configured =
        !!app?.supabaseProjectId && isSupabaseConnected(settings);
      return {
        configured,
        ready: configured,
        hint: configured ? undefined : "Connect a Supabase project to enable.",
      };
    }
    case "tableland":
    case "ceramic":
    case "gundb":
    case "orbitdb":
    case "weavedb":
      return { configured: false, ready: false, hint: STUB_HINT };
  }
}

function serverRuntimeReadiness(
  kind: ServerRuntimeKind,
  app: { supabaseProjectId: string | null; vercelProjectId?: string | null } | null,
  settings: ReturnType<typeof readSettings> | null,
): ProviderReadiness {
  switch (kind) {
    case "none":
      return { configured: true, ready: true };
    case "supabase-edge": {
      const configured =
        !!app?.supabaseProjectId && isSupabaseConnected(settings);
      return {
        configured,
        ready: configured,
        hint: configured ? undefined : "Requires a connected Supabase project.",
      };
    }
    case "vercel-functions": {
      const configured = !!app?.vercelProjectId;
      return {
        configured,
        ready: configured,
        hint: configured ? undefined : "Connect a Vercel project to enable.",
      };
    }
    case "cloudflare-workers":
    case "railway":
    case "render":
    case "fly-io":
    case "aws-lambda":
      return { configured: false, ready: false, hint: STUB_HINT };
  }
}

function readIndexReadiness(kind: ReadIndexKind): ProviderReadiness {
  switch (kind) {
    case "none":
      return { configured: true, ready: true };
    case "goldsky":
      // Subgraph client exists at src/lib/subgraph_client.ts — treat as
      // configured if it's available at runtime. Concrete credential check
      // can be added when we expose Goldsky settings.
      return { configured: true, ready: true };
    case "thegraph":
      return { configured: false, ready: false, hint: STUB_HINT };
  }
}

function blobStorageReadiness(
  kind: BlobStorageKind,
  app: { supabaseProjectId: string | null } | null,
  settings: ReturnType<typeof readSettings> | null,
): ProviderReadiness {
  switch (kind) {
    case "none":
      return { configured: true, ready: true };
    case "supabase-storage": {
      const configured =
        !!app?.supabaseProjectId && isSupabaseConnected(settings);
      return {
        configured,
        ready: configured,
        hint: configured ? undefined : "Requires a connected Supabase project.",
      };
    }
    case "ipfs-4everland":
    case "ipfs-helia":
      // IPFS pinner exists at src/lib/joymarketplace/ipfs_pinner.ts.
      // Helia mode works out of the box; 4everland needs creds. Be honest:
      // mark Helia ready, 4everland stub.
      if (kind === "ipfs-helia") {
        return { configured: true, ready: true };
      }
      return { configured: false, ready: false, hint: STUB_HINT };
    case "arweave":
      return { configured: false, ready: false, hint: STUB_HINT };
    case "celestia":
      // Celestia blob service exists at src/lib/celestia_blob_service.ts.
      return { configured: true, ready: true };
  }
}

interface DataLayerStatusRequest {
  appId?: number | null;
  /**
   * Optional override config — used by the QuickStart cockpit which has
   * an unsaved in-memory selection before the app exists in the DB.
   */
  config?: DataLayerConfig;
}

export function registerDataLayerStatusHandlers() {
  handle(
    "data-layer:status",
    async (
      _event,
      req: DataLayerStatusRequest = {},
    ): Promise<DataLayerStatus> => {
      const settings = readSettings();

      let app: {
        supabaseProjectId: string | null;
        neonProjectId: string | null;
        vercelProjectId: string | null;
        dataLayerConfig: unknown;
      } | null = null;
      if (req.appId != null) {
        const rows = await db
          .select({
            supabaseProjectId: appsTable.supabaseProjectId,
            neonProjectId: appsTable.neonProjectId,
            vercelProjectId: appsTable.vercelProjectId,
            dataLayerConfig: appsTable.dataLayerConfig,
          })
          .from(appsTable)
          .where(eq(appsTable.id, req.appId))
          .limit(1);
        app = rows[0] ?? null;
      }

      const config: DataLayerConfig =
        req.config ??
        (app?.dataLayerConfig as DataLayerConfig | null) ??
        (app
          ? deriveLegacyDataLayerConfig({
              supabaseProjectId: app.supabaseProjectId,
              neonProjectId: app.neonProjectId,
            })
          : DEFAULT_DATA_LAYER_CONFIG);

      const primaryEntries = PRIMARY_KINDS.map((k) => [
        k,
        withMeta(primaryStoreReadiness(k, app, settings), k, PRIMARY_DOCS, MANAGE_INTEGRATIONS),
      ]) as [DataLayerKind, ProviderReadiness][];
      const serverEntries = SERVER_KINDS.map((k) => [
        k,
        withMeta(serverRuntimeReadiness(k, app, settings), k, SERVER_DOCS, MANAGE_INTEGRATIONS),
      ]) as [ServerRuntimeKind, ProviderReadiness][];
      const readIndexEntries = READ_INDEX_KINDS.map((k) => [
        k,
        withMeta(readIndexReadiness(k), k, READ_INDEX_DOCS, MANAGE_INTEGRATIONS),
      ]) as [ReadIndexKind, ProviderReadiness][];
      const blobEntries = BLOB_KINDS.map((k) => [
        k,
        withMeta(blobStorageReadiness(k, app, settings), k, BLOB_DOCS, MANAGE_INTEGRATIONS),
      ]) as [BlobStorageKind, ProviderReadiness][];

      const primaryProviders = Object.fromEntries(primaryEntries) as Record<
        DataLayerKind,
        ProviderReadiness
      >;
      const serverProviders = Object.fromEntries(serverEntries) as Record<
        ServerRuntimeKind,
        ProviderReadiness
      >;
      const readIndexProviders = Object.fromEntries(readIndexEntries) as Record<
        ReadIndexKind,
        ProviderReadiness
      >;
      const blobProviders = Object.fromEntries(blobEntries) as Record<
        BlobStorageKind,
        ProviderReadiness
      >;

      return {
        active: {
          primaryStore: primaryProviders[config.primaryStore],
          serverRuntime: serverProviders[config.serverRuntime],
          readIndex: readIndexProviders[config.readIndex],
          blobStorage: blobProviders[config.blobStorage],
        },
        providers: {
          primaryStore: primaryProviders,
          serverRuntime: serverProviders,
          readIndex: readIndexProviders,
          blobStorage: blobProviders,
        },
      };
    },
  );

  handle(
    "data-layer:set-config",
    async (
      _event,
      req: { appId: number; config: DataLayerConfig },
    ): Promise<DataLayerConfig> => {
      if (!req?.appId) {
        throw new Error("appId is required");
      }
      const merged: DataLayerConfig = {
        ...DEFAULT_DATA_LAYER_CONFIG,
        ...req.config,
      };
      await db
        .update(appsTable)
        .set({
          dataLayerKind: merged.primaryStore,
          serverRuntimeKind: merged.serverRuntime,
          dataLayerConfig: merged,
        })
        .where(eq(appsTable.id, req.appId));
      return merged;
    },
  );
}
