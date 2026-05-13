/**
 * JoyBridge IPC handlers — single canonical namespace for the
 * JoyCreate ↔ JoyMarketplace integration.
 *
 * Backed by `src/lib/joybridge_client.ts`. These handlers are thin wrappers:
 * all transport logic lives in the client. Settings are persisted to a
 * dedicated JSON file in userData (matches the pattern used by
 * `marketplace_sync_handlers.ts`).
 *
 * The 11 channels exposed:
 *   joybridge:get-config
 *   joybridge:connect
 *   joybridge:create-store
 *   joybridge:get-store
 *   joybridge:list-my-stores
 *   joybridge:publish-asset
 *   joybridge:get-asset
 *   joybridge:list-my-assets
 *   joybridge:browse-marketplace
 *   joybridge:goldsky-query
 *   joybridge:pin-to-ipfs
 *
 * Reminder (per Collab Hub PR #16 post-mortem): every channel below MUST also
 * be added to `validInvokeChannels` in `src/preload.ts`, otherwise the
 * renderer can't reach it.
 */

import { ipcMain, app } from "electron";
import * as fs from "fs-extra";
import * as path from "path";
import log from "electron-log";

import {
  JoyBridgeClient,
  type CreateStoreInput,
  type PublishAssetInput,
  type BrowseQuery,
  type Asset as BridgeAsset,
  type Store as BridgeStore,
  type Result,
  type BrowseResult,
} from "@/lib/joybridge_client";
import {
  publishAndForget,
  type AssetType,
  type PublishInput as OrchestratorInput,
} from "@/lib/joymarketplace/publish_orchestrator";

const logger = log.scope("joybridge_handlers");

// ── Subgraph fallback helpers ───────────────────────────────────────────────
//
// The Supabase edge functions for `list-my-assets` / `list-my-stores` /
// `marketplace-listing` are currently broken (e.g. they SELECT `digital_assets.name`
// which doesn't exist) and require a Supabase JWT we don't have. Whenever
// the edge function fails or the user has no joy_xxx key configured, we
// fall back to reading the same data straight from Goldsky's subgraph using
// the connected chain wallet.

/** Read the active secp256k1 wallet address from JcnKeyManager. */
async function getActiveChainWallet(): Promise<string | null> {
  try {
    const { jcnKeyManager } = await import("@/lib/jcn_key_manager");
    await jcnKeyManager.initialize();
    const keys = await jcnKeyManager.listKeys("chain");
    const active = keys.find((k) => k.active && k.algorithm === "secp256k1");
    return active?.walletAddress ?? active?.publicKey ?? null;
  } catch (err) {
    logger.warn("getActiveChainWallet failed:", (err as Error).message);
    return null;
  }
}

/** True if the Supabase Result is a hard failure (network/4xx/5xx or empty payload). */
function isEdgeFailure(res: Result<unknown>): boolean {
  if (!res?.ok) return true;
  // Some edge functions return 200 with `{ ok: false, error: "..." }` payloads.
  const data = res.data as { ok?: boolean; error?: string } | undefined;
  if (data && data.ok === false && typeof data.error === "string") return true;
  return false;
}

function edgeErrorMessage(res: Result<unknown>): string {
  if (!res) return "no response";
  if (!res.ok) return res.error ?? "unknown error";
  const data = res.data as { error?: string } | undefined;
  return data?.error ?? "unknown error";
}

async function fallbackListMyStores(): Promise<Result<BridgeStore[]>> {
  const wallet = await getActiveChainWallet();
  if (!wallet) {
    return { ok: false, error: "no chain wallet — connect a secp256k1 wallet in Settings" };
  }
  try {
    const { getUserStores } = await import("@/lib/subgraph_client");
    const subStores = await getUserStores(wallet);
    const mapped: BridgeStore[] = subStores.map((s) => ({
      id: s.id,
      slug: s.domain ?? s.id,
      name: s.name ?? s.domain ?? "Unnamed store",
      description: s.description ?? undefined,
      ownerWallet: s.owner,
      bannerUrl: undefined,
      logoUrl: s.logo ?? undefined,
      status: s.isActive ? "active" : "disabled",
      createdAt: s.createdAt ?? undefined,
    }));
    return { ok: true, data: mapped };
  } catch (err) {
    return { ok: false, error: `subgraph: ${(err as Error).message}` };
  }
}

async function fallbackListMyAssets(): Promise<Result<BridgeAsset[]>> {
  const wallet = await getActiveChainWallet();
  if (!wallet) {
    return { ok: false, error: "no chain wallet — connect a secp256k1 wallet in Settings" };
  }
  try {
    const { getUserBalances, getUserPurchases } = await import("@/lib/subgraph_client");
    const [balances, purchases] = await Promise.all([
      getUserBalances(wallet).catch(() => []),
      getUserPurchases(wallet).catch(() => []),
    ]);

    // Tokens currently held by the wallet (claimed > 0).
    const owned: BridgeAsset[] = balances
      .filter((b) => Number(b.totalClaimed ?? "0") > 0)
      .map((b) => {
        const t = b.token;
        const baseURI = t?.baseURI ?? "";
        const cidLike = baseURI.replace(/^ipfs:\/\//, "");
        return {
          id: b.id,
          tokenId: String(t?.tokenId ?? b.tokenId),
          storeId: "",
          assetType: "token",
          name: cidLike ? `Token #${t?.tokenId ?? b.tokenId}` : `Token #${b.tokenId}`,
          description: baseURI || undefined,
          contentUrl: baseURI ? baseURI.replace(/^ipfs:\/\//, "https://ipfs.io/ipfs/") : undefined,
          priceUsdc: t?.pricePerToken ? Number(t.pricePerToken) : undefined,
          status: "active",
          createdAt: t?.lazyMintedAt
            ? new Date(Number(t.lazyMintedAt) * 1000).toISOString()
            : undefined,
        } satisfies BridgeAsset;
      });

    // Also include any tokens the user *purchased* (already covered by balances,
    // but kept for parity with the legacy `digital_assets` shape).
    const seen = new Set(owned.map((a) => a.tokenId));
    for (const p of purchases) {
      if (seen.has(String(p.tokenId))) continue;
      seen.add(String(p.tokenId));
      owned.push({
        id: p.id,
        tokenId: String(p.tokenId),
        storeId: "",
        assetType: "token",
        name: `Token #${p.tokenId}`,
        priceUsdc: undefined,
        status: "active",
        createdAt: p.timestamp
          ? new Date(Number(p.timestamp) * 1000).toISOString()
          : undefined,
      });
    }

    return { ok: true, data: owned };
  } catch (err) {
    return { ok: false, error: `subgraph: ${(err as Error).message}` };
  }
}

async function fallbackBrowseMarketplace(query: BrowseQuery): Promise<Result<BrowseResult>> {
  try {
    const { getTokens } = await import("@/lib/subgraph_client");
    const tokens = await getTokens({ first: query.limit ?? 100 });
    const items: BridgeAsset[] = tokens.map((t) => ({
      id: t.id,
      tokenId: String(t.tokenId),
      storeId: "",
      assetType: "token",
      name: `Token #${t.tokenId}`,
      description: t.baseURI || undefined,
      contentUrl: t.baseURI?.startsWith("ipfs://")
        ? t.baseURI.replace(/^ipfs:\/\//, "https://ipfs.io/ipfs/")
        : t.baseURI ?? undefined,
      priceUsdc: t.pricePerToken ? Number(t.pricePerToken) : undefined,
      status: "active",
      createdAt: t.lazyMintedAt
        ? new Date(Number(t.lazyMintedAt) * 1000).toISOString()
        : undefined,
    }));
    return { ok: true, data: { items, total: items.length } };
  } catch (err) {
    return { ok: false, error: `subgraph: ${(err as Error).message}` };
  }
}

// -- Persisted config --------------------------------------------------------

interface JoyBridgeStoredConfig {
  apiBase?: string;
  webBase?: string;
  apiKey?: string;
  supabaseUrl?: string;
  supabasePublishableKey?: string;
}

let storedConfig: JoyBridgeStoredConfig = {};
let client: JoyBridgeClient | undefined;

function configPath(): string {
  return path.join(app.getPath("userData"), "joybridge-config.json");
}

async function loadConfig(): Promise<JoyBridgeStoredConfig> {
  try {
    const p = configPath();
    if (await fs.pathExists(p)) {
      storedConfig = (await fs.readJson(p)) ?? {};
    }
  } catch (err) {
    logger.warn("Failed to load joybridge config:", err);
  }
  // Env overlay (env wins over disk for CI / dev).
  const envApiBase = process.env.JOYBRIDGE_API_BASE
    ?? process.env.JOYMARKETPLACE_API_URL;
  const envWebBase = process.env.JOYBRIDGE_WEB_BASE
    ?? process.env.JOYMARKETPLACE_WEB_URL;
  const envSupabaseUrl = process.env.SUPABASE_URL
    ?? process.env.JOYMARKETPLACE_SUPABASE_URL;
  const envSupabaseKey = process.env.SUPABASE_PUBLISHABLE_KEY
    ?? process.env.VITE_SUPABASE_PUBLISHABLE_KEY
    ?? process.env.JOYMARKETPLACE_SUPABASE_ANON_KEY;
  const envApiKey = process.env.JOY_API_KEY;

  if (envApiBase) storedConfig.apiBase = envApiBase;
  if (envWebBase) storedConfig.webBase = envWebBase;
  if (envSupabaseUrl) storedConfig.supabaseUrl = envSupabaseUrl;
  if (envSupabaseKey) storedConfig.supabasePublishableKey = envSupabaseKey;
  if (envApiKey && !storedConfig.apiKey) storedConfig.apiKey = envApiKey;

  return storedConfig;
}

async function saveConfig(patch: Partial<JoyBridgeStoredConfig>): Promise<void> {
  storedConfig = { ...storedConfig, ...patch };
  // Don't persist env-derived fields if they came purely from env.
  const onDisk = { ...storedConfig };
  await fs.writeJson(configPath(), onDisk, { spaces: 2 });
  // Refresh the client.
  ensureClient(true);
}

function ensureClient(forceReload = false): JoyBridgeClient {
  if (!client || forceReload) {
    client = new JoyBridgeClient({
      apiBase: storedConfig.apiBase,
      webBase: storedConfig.webBase,
      apiKey: storedConfig.apiKey,
      supabaseUrl: storedConfig.supabaseUrl,
      supabasePublishableKey: storedConfig.supabasePublishableKey,
    });
  }
  return client;
}

/**
 * Public helper for sibling main-process handlers (e.g. agent install) that
 * need to look up an asset's IPFS / HTTPS content URL given a tokenId or
 * marketplace asset id. Keeps `ensureClient`/`loadConfig` private while
 * giving cross-handler code a stable, narrow API.
 */
export async function resolveAssetContentUrl(
  idOrToken: string,
): Promise<string | undefined> {
  await loadConfig();
  const asset = (await ensureClient().getAsset(idOrToken)) as
    | { contentUrl?: string; data?: { contentUrl?: string } }
    | null;
  return asset?.contentUrl ?? asset?.data?.contentUrl;
}

// -- Pure helpers (exported for tests) --------------------------------------

export const __test__ = {
  /** Names of every IPC channel this module registers. */
  CHANNELS: [
    "joybridge:get-config",
    "joybridge:connect",
    "joybridge:create-store",
    "joybridge:get-store",
    "joybridge:list-my-stores",
    "joybridge:publish-asset",
    "joybridge:get-asset",
    "joybridge:list-my-assets",
    "joybridge:browse-marketplace",
    "joybridge:goldsky-query",
    "joybridge:pin-to-ipfs",
  ] as const,
  loadConfig,
  saveConfig,
  ensureClient,
  /** For tests only — inject a fully-formed client. */
  setClientForTests(c: JoyBridgeClient | undefined): void {
    client = c;
  },
  /** Reset in-memory state for tests. */
  resetForTests(): void {
    storedConfig = {};
    client = undefined;
  },
};

// -- Registration ------------------------------------------------------------

export function registerJoyBridgeHandlers(): void {
  // Lazy load on first call rather than at register time.
  ipcMain.handle("joybridge:get-config", async () => {
    await loadConfig();
    const c = ensureClient();
    return c.getConfig();
  });

  ipcMain.handle(
    "joybridge:connect",
    async (
      _e,
      input: {
        apiKey?: string;
        apiBase?: string;
        webBase?: string;
        supabaseUrl?: string;
        supabasePublishableKey?: string;
      },
    ) => {
      await loadConfig();
      await saveConfig({
        apiKey: input.apiKey ?? storedConfig.apiKey,
        apiBase: input.apiBase ?? storedConfig.apiBase,
        webBase: input.webBase ?? storedConfig.webBase,
        supabaseUrl: input.supabaseUrl ?? storedConfig.supabaseUrl,
        supabasePublishableKey:
          input.supabasePublishableKey ?? storedConfig.supabasePublishableKey,
      });
      const c = ensureClient(true);
      logger.info("JoyBridge connected", { apiBase: c.getConfig().apiBase });
      return c.getConfig();
    },
  );

  ipcMain.handle(
    "joybridge:create-store",
    async (_e, input: CreateStoreInput) => {
      await loadConfig();
      return ensureClient().createStore(input);
    },
  );

  ipcMain.handle("joybridge:get-store", async (_e, slug: string) => {
    await loadConfig();
    return ensureClient().getStore(slug);
  });

  ipcMain.handle("joybridge:list-my-stores", async () => {
    await loadConfig();
    const edge = await ensureClient().listMyStores();
    if (!isEdgeFailure(edge)) return edge;
    logger.warn(
      `joybridge:list-my-stores edge function failed (${edgeErrorMessage(edge)}); falling back to subgraph`,
    );
    return fallbackListMyStores();
  });

  ipcMain.handle(
    "joybridge:publish-asset",
    async (
      _e,
      input: PublishAssetInput & {
        /** Default true — the Supabase publish-asset edge function 401s for joy_xxx
         * keys, so on-chain is the primary path going forward. Set to false to
         * keep the legacy Supabase publish call (only useful while we still have
         * callers that haven't migrated). */
        onchain?: boolean;
        dryRun?: boolean;
        /** Raw content (orchestrator-only) — base64 of bytes to pin to IPFS. */
        contentBase64?: string;
        contentMimeType?: string;
        /** Optional flat metadata bag passed through. */
        properties?: Record<string, unknown>;
        quantity?: number;
      },
    ) => {
      await loadConfig();
      const useOnchain = input.dryRun === true || (input.onchain ?? true);
      if (useOnchain) {
        const buf =
          input.contentBase64 != null
            ? Buffer.from(input.contentBase64, "base64")
            : undefined;
        const orchInput: OrchestratorInput = {
          assetType: (input.assetType as AssetType) ?? "document",
          name: input.name,
          description: input.description,
          contentBuffer: buf,
          contentMimeType: input.contentMimeType,
          metadata: input.properties,
          priceUsdc: typeof input.priceUsdc === "number" ? input.priceUsdc : undefined,
          royaltyBps: input.royaltyBps,
          quantity: input.quantity ?? 1,
          dryRun: input.dryRun,
          license: input.license,
        };
        const outcome = await publishAndForget(orchInput);
        // Map PublishOutcome → Result<Asset> shape so renderer's res.ok/res.error
        // rendering surfaces real failure reasons (no-signer, no-gate, etc.)
        // instead of an empty error string.
        if (outcome.ok) {
          const asset: BridgeAsset = {
            id: outcome.tokenId ?? String(outcome.bundleId ?? ""),
            tokenId: outcome.tokenId,
            storeId: "",
            assetType: input.assetType ?? "document",
            name: input.name,
            description: input.description,
            contentUrl: outcome.metadataUri,
            priceUsdc: typeof input.priceUsdc === "number" ? input.priceUsdc : undefined,
            royaltyBps: input.royaltyBps,
            status: "active",
            createdAt: new Date().toISOString(),
          };
          return { ok: true, data: asset, outcome } as Result<BridgeAsset> & {
            outcome: typeof outcome;
          };
        }
        const errMsg =
          (outcome.errors && outcome.errors.length
            ? outcome.errors.join("; ")
            : undefined) ??
          (outcome.blockedAt ? `blocked at ${outcome.blockedAt}` : "publish failed");
        return {
          ok: false,
          error: errMsg,
          outcome,
        } as Result<BridgeAsset> & { outcome: typeof outcome };
      }
      return ensureClient().publishAsset(input);
    },
  );

  ipcMain.handle("joybridge:get-asset", async (_e, idOrToken: string) => {
    await loadConfig();
    return ensureClient().getAsset(idOrToken);
  });

  ipcMain.handle("joybridge:list-my-assets", async () => {
    await loadConfig();
    const edge = await ensureClient().listMyAssets();
    if (!isEdgeFailure(edge)) return edge;
    logger.warn(
      `joybridge:list-my-assets edge function failed (${edgeErrorMessage(edge)}); falling back to subgraph`,
    );
    return fallbackListMyAssets();
  });

  ipcMain.handle(
    "joybridge:browse-marketplace",
    async (_e, query: BrowseQuery) => {
      await loadConfig();
      const edge = await ensureClient().browseMarketplace(query ?? {});
      if (!isEdgeFailure(edge)) return edge;
      logger.warn(
        `joybridge:browse-marketplace edge function failed (${edgeErrorMessage(edge)}); falling back to subgraph`,
      );
      return fallbackBrowseMarketplace(query ?? {});
    },
  );

  ipcMain.handle(
    "joybridge:goldsky-query",
    async (
      _e,
      input: {
        endpoint: string;
        query: string;
        variables?: Record<string, unknown>;
      },
    ) => {
      await loadConfig();
      return ensureClient().goldskyQuery(
        input.endpoint,
        input.query,
        input.variables,
      );
    },
  );

  ipcMain.handle(
    "joybridge:pin-to-ipfs",
    async (
      _e,
      input: {
        data: ArrayBuffer | string;
        filename?: string;
        contentType?: string;
      },
    ) => {
      await loadConfig();
      return ensureClient().pinToIpfs(input);
    },
  );

  logger.info(`JoyBridge handlers registered (${__test__.CHANNELS.length} channels)`);
}

export default registerJoyBridgeHandlers;
