/**
 * On-Chain Asset Bridge IPC Handlers
 *
 * Bridges on-chain ERC-1155 JoyLicenseToken assets (from Joy Marketplace drop edition)
 * into the local JoyCreate Asset Studio. Also enables agents to autonomously
 * browse, buy, list, and sell marketplace assets.
 *
 * Chain: Polygon Amoy Testnet (80002)
 * Contract: the per-store DropERC1155 clone each token lives on, or the shared
 * platform drop for pre-per-store assets. (Was the retired Polygon Amoy
 * JoyLicenseToken, hardcoded.)
 * Subgraphs: joy-marketplace-amoy, joy-stores-amoy, joy-drop-amoy (Goldsky)
 */

import { ipcMain, app } from "electron";
import * as fs from "fs-extra";
import * as path from "path";
import log from "electron-log";
import type { Asset, AssetType } from "@/types/asset_types";
import { ARB_SEPOLIA_ENS_CONTRACTS } from "@/config/joymarketplace";
import {
  getUserBalances,
  getMarketplaceAssets,
  getUserPurchases,
} from "@/lib/subgraph_client";

const logger = log.scope("onchain-bridge");

// ── Config ────────────────────────────────────────────────────────────────

const IPFS_GATEWAYS = [
  "https://ipfs.io/ipfs/",
  "https://gateway.pinata.cloud/ipfs/",
  "https://4everland.io/ipfs/",
  "https://cloudflare-ipfs.com/ipfs/",
];

function getAssetsDir(): string {
  return path.join(app.getPath("userData"), "assets");
}

function getBridgeStateDir(): string {
  return path.join(app.getPath("userData"), "onchain-bridge");
}

// ── Metadata resolution ───────────────────────────────────────────────────

/**
 * Resolve token metadata from baseURI (IPFS or HTTP)
 */
async function resolveTokenMetadata(baseURI: string, tokenId: string): Promise<any> {
  // baseURI often has {id} placeholder or needs /tokenId appended
  let uri = baseURI;
  if (uri.includes("{id}")) {
    uri = uri.replace("{id}", tokenId);
  } else if (!uri.endsWith("/")) {
    uri = `${uri}/${tokenId}`;
  } else {
    uri = `${uri}${tokenId}`;
  }

  // Resolve IPFS URIs
  if (uri.startsWith("ipfs://")) {
    const cid = uri.replace("ipfs://", "");
    for (const gw of IPFS_GATEWAYS) {
      try {
        const res = await fetch(`${gw}${cid}`, { signal: AbortSignal.timeout(10000) });
        if (res.ok) return res.json();
      } catch {
        continue;
      }
    }
    throw new Error(`Failed to resolve IPFS metadata: ${uri}`);
  }

  // HTTP URI
  const res = await fetch(uri, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Metadata fetch failed: ${res.status}`);
  return res.json();
}

/**
 * Map on-chain metadata to local Asset Studio asset type
 */
function mapMetadataToAssetType(metadata: any): AssetType {
  const category = (metadata.category || metadata.asset_type || "").toLowerCase();
  const name = (metadata.name || "").toLowerCase();
  const desc = (metadata.description || "").toLowerCase();

  if (category.includes("model") || category.includes("ai-model") || name.includes("model"))
    return "model";
  if (category.includes("dataset") || category.includes("data"))
    return "dataset";
  if (category.includes("agent") || category.includes("bot"))
    return "agent";
  if (category.includes("algorithm") || category.includes("code"))
    return "algorithm";
  if (category.includes("prompt"))
    return "prompt";
  if (category.includes("workflow") || category.includes("automation"))
    return "workflow";
  if (category.includes("template") || category.includes("app"))
    return "template";
  if (category.includes("schema") || category.includes("api"))
    return "schema";
  if (category.includes("plugin") || category.includes("extension"))
    return "plugin";
  if (category.includes("component") || category.includes("ui"))
    return "ui-component";
  if (category.includes("training"))
    return "training-data";
  if (category.includes("embedding") || category.includes("vector"))
    return "embedding";

  // Default based on description keywords
  if (desc.includes("trained") || desc.includes("neural") || desc.includes("weights"))
    return "model";
  if (desc.includes("dataset") || desc.includes("data collection"))
    return "dataset";

  return "model"; // Safe default for marketplace AI assets
}

/**
 * Convert on-chain token to local Asset Studio asset
 */
function tokenToLocalAsset(
  tokenId: string,
  metadata: any,
  onChainData: {
    contractAddress: string;
    owner: string;
    price?: string;
    totalClaimed?: string;
  },
): Asset {
  const assetType = mapMetadataToAssetType(metadata);
  const now = new Date().toISOString();

  const base = {
    id: `onchain-${tokenId}`,
    name: metadata.name || `Token #${tokenId}`,
    description: metadata.description || "",
    version: metadata.version || "1.0.0",
    author: metadata.creator || onChainData.owner || "unknown",
    license: (metadata.license_type || "commercial") as any,
    tags: [
      ...(metadata.tags || []),
      "on-chain",
      "erc-1155",
      `token:${tokenId}`,
    ],
    category: metadata.category || assetType,
    thumbnail: metadata.image || metadata.thumbnail || undefined,
    readme: metadata.long_description || metadata.readme || undefined,
    createdAt: metadata.created_at || now,
    updatedAt: now,
    marketplaceId: `joy-marketplace:${tokenId}`,
    price: onChainData.price ? parseFloat(onChainData.price) / 1e18 : undefined,
    downloads: parseInt(onChainData.totalClaimed || "0"),
  };

  // Build type-specific asset
  switch (assetType) {
    case "model":
      return {
        ...base,
        type: "model",
        modelType: metadata.model_type || "custom",
        framework: metadata.framework || "custom",
        baseModel: metadata.base_model,
        parameters: metadata.parameters,
        inputFormat: metadata.input_format || "json",
        outputFormat: metadata.output_format || "json",
        filePath: "", // Set after download
      } as any;
    case "agent":
      return {
        ...base,
        type: "agent",
        agentType: metadata.agent_type || "task",
        model: metadata.model || "unknown",
        systemPrompt: metadata.system_prompt || "",
        tools: metadata.tools || [],
        configPath: "",
      } as any;
    case "dataset":
      return {
        ...base,
        type: "dataset",
        format: metadata.format || "json",
        schema: metadata.schema || { fields: [] },
        rowCount: metadata.row_count || 0,
        sizeBytes: metadata.size_bytes || 0,
        filePath: "",
      } as any;
    default:
      return {
        ...base,
        type: assetType,
        filePath: "",
      } as any;
  }
}

// ── Bridge state persistence ──────────────────────────────────────────────

interface BridgeState {
  importedTokens: Record<string, { localAssetId: string; importedAt: string; tokenId: string }>;
  lastSync: string | null;
  walletAddress: string | null;
}

async function loadBridgeState(): Promise<BridgeState> {
  const stateFile = path.join(getBridgeStateDir(), "bridge-state.json");
  try {
    if (await fs.pathExists(stateFile)) {
      return fs.readJson(stateFile);
    }
  } catch {}
  return { importedTokens: {}, lastSync: null, walletAddress: null };
}

async function saveBridgeState(state: BridgeState): Promise<void> {
  await fs.ensureDir(getBridgeStateDir());
  await fs.writeJson(path.join(getBridgeStateDir(), "bridge-state.json"), state, { spaces: 2 });
}

// ── Handler registration ──────────────────────────────────────────────────

export function registerOnchainAssetBridgeHandlers() {
  logger.info("Registering on-chain asset bridge handlers");

  // =========================================================================
  // IMPORT: Fetch user's ERC-1155 tokens and import into Asset Studio
  // =========================================================================

  /**
   * Get all owned ERC-1155 tokens from Joy Marketplace (via subgraph)
   * Returns enriched data with resolved metadata
   */
  ipcMain.handle(
    "onchain-bridge:get-owned-tokens",
    async (_, walletAddress: string) => {
      if (!walletAddress) throw new Error("walletAddress is required");
      logger.info(`Fetching owned tokens for ${walletAddress}`);

      const balances = await getUserBalances(walletAddress);

      // Resolve metadata for each token
      const tokensWithMeta = await Promise.all(
        balances.map(async (balance) => {
          let metadata: any = {};
          try {
            if (balance.token?.baseURI) {
              metadata = await resolveTokenMetadata(balance.token.baseURI, balance.tokenId);
            }
          } catch (err) {
            logger.warn(`Failed to resolve metadata for token ${balance.tokenId}:`, err);
          }

          return {
            tokenId: balance.tokenId,
            totalClaimed: balance.totalClaimed,
            lastClaimedAt: balance.lastClaimedAt,
            baseURI: balance.token?.baseURI,
            pricePerToken: balance.token?.pricePerToken,
            currency: balance.token?.currency,
            totalPurchases: balance.token?.totalPurchases,
            metadata,
            suggestedAssetType: mapMetadataToAssetType(metadata),
          };
        }),
      );

      return {
        walletAddress,
        tokenCount: tokensWithMeta.length,
        tokens: tokensWithMeta,
      };
    },
  );

  /**
   * Import a specific on-chain token into the local Asset Studio
   */
  ipcMain.handle(
    "onchain-bridge:import-token",
    async (
      _,
      params: {
        walletAddress: string;
        tokenId: string;
        metadata?: any;
        baseURI?: string;
        overrideAssetType?: AssetType;
      },
    ) => {
      const { walletAddress, tokenId, overrideAssetType } = params;
      logger.info(`Importing token ${tokenId} for ${walletAddress}`);

      const state = await loadBridgeState();

      // Check if already imported
      if (state.importedTokens[tokenId]) {
        logger.info(`Token ${tokenId} already imported as ${state.importedTokens[tokenId].localAssetId}`);
        return {
          success: true,
          alreadyImported: true,
          localAssetId: state.importedTokens[tokenId].localAssetId,
        };
      }

      // Resolve metadata if not provided
      let metadata = params.metadata;
      if (!metadata && params.baseURI) {
        metadata = await resolveTokenMetadata(params.baseURI, tokenId);
      }
      if (!metadata) {
        metadata = { name: `Token #${tokenId}`, description: "Imported from Joy Marketplace" };
      }

      // Convert to local asset
      const asset = tokenToLocalAsset(tokenId, metadata, {
        contractAddress: ARB_SEPOLIA_ENS_CONTRACTS.platformDrop,
        owner: walletAddress,
      });

      // Apply override type if specified
      if (overrideAssetType) {
        (asset as any).type = overrideAssetType;
      }

      // Save to asset studio
      const assetDir = path.join(getAssetsDir(), asset.type);
      await fs.ensureDir(assetDir);
      const metaPath = path.join(assetDir, `${asset.id}.meta.json`);
      await fs.writeJson(metaPath, asset, { spaces: 2 });

      // Update bridge state
      state.importedTokens[tokenId] = {
        localAssetId: asset.id,
        importedAt: new Date().toISOString(),
        tokenId,
      };
      state.walletAddress = walletAddress;
      state.lastSync = new Date().toISOString();
      await saveBridgeState(state);

      logger.info(`Token ${tokenId} imported as ${asset.type} asset: ${asset.id}`);

      return {
        success: true,
        alreadyImported: false,
        localAssetId: asset.id,
        assetType: asset.type,
        asset,
      };
    },
  );

  /**
   * Bulk import all owned tokens into Asset Studio
   */
  ipcMain.handle(
    "onchain-bridge:import-all",
    async (_, walletAddress: string) => {
      if (!walletAddress) throw new Error("walletAddress is required");
      logger.info(`Bulk importing all tokens for ${walletAddress}`);

      const balances = await getUserBalances(walletAddress);
      const results: Array<{ tokenId: string; success: boolean; localAssetId?: string; error?: string }> = [];

      for (const balance of balances) {
        try {
          let metadata: any = {};
          if (balance.token?.baseURI) {
            metadata = await resolveTokenMetadata(balance.token.baseURI, balance.tokenId);
          }

          // Invoke the single import handler logic inline
          const asset = tokenToLocalAsset(balance.tokenId, metadata, {
            contractAddress: ARB_SEPOLIA_ENS_CONTRACTS.platformDrop,
            owner: walletAddress,
            price: balance.token?.pricePerToken ?? undefined,
            totalClaimed: balance.totalClaimed,
          });

          const assetDir = path.join(getAssetsDir(), asset.type);
          await fs.ensureDir(assetDir);
          await fs.writeJson(
            path.join(assetDir, `${asset.id}.meta.json`),
            asset,
            { spaces: 2 },
          );

          const state = await loadBridgeState();
          state.importedTokens[balance.tokenId] = {
            localAssetId: asset.id,
            importedAt: new Date().toISOString(),
            tokenId: balance.tokenId,
          };
          state.walletAddress = walletAddress;
          state.lastSync = new Date().toISOString();
          await saveBridgeState(state);

          results.push({ tokenId: balance.tokenId, success: true, localAssetId: asset.id });
        } catch (err: any) {
          logger.warn(`Failed to import token ${balance.tokenId}:`, err);
          results.push({ tokenId: balance.tokenId, success: false, error: err.message });
        }
      }

      return {
        total: balances.length,
        imported: results.filter((r) => r.success).length,
        failed: results.filter((r) => !r.success).length,
        results,
      };
    },
  );

  /**
   * Get import status / bridge state
   */
  ipcMain.handle("onchain-bridge:status", async () => {
    const state = await loadBridgeState();
    return {
      walletAddress: state.walletAddress,
      importedCount: Object.keys(state.importedTokens).length,
      lastSync: state.lastSync,
      importedTokens: state.importedTokens,
    };
  });

  // =========================================================================
  // AGENT MARKETPLACE AUTONOMY
  // Agents can browse, buy, list, and sell assets on Joy Marketplace
  // =========================================================================

  /**
   * Agent: Browse marketplace for available assets
   * Used by agents to find tools/models/data they need
   */
  ipcMain.handle(
    "agent-market:browse",
    async (
      _,
      params: {
        agentId: string;
        query?: string;
        assetType?: string;
        maxPrice?: number;
        first?: number;
      },
    ) => {
      logger.info(`Agent ${params.agentId} browsing marketplace`, params);

      // Reads the live drop subgraph. This used to call getMarketplaceListings,
      // an entity of the retired MarketplaceV3 subgraph on Polygon Amoy — the
      // endpoint 404s and nothing on Arbitrum indexes `listings`.
      //
      // The on-chain catalogue carries no name or asset type; those live in the
      // token's IPFS metadata. Name/type filtering therefore cannot be done
      // here, and asking for it returns an explicit note rather than silently
      // ignoring the filter and implying the result set was filtered.
      const { listDrops } = await import("@/lib/joymarketplace/drop_subgraph");
      const { items } = await listDrops({ pageSize: Math.min(params.first ?? 50, 100) });

      const priced = items.map((t) => ({
        id: t.id,
        tokenId: t.tokenId,
        contract: (t as { contract?: string }).contract,
        baseURI: t.baseURI,
        // pricePerToken is in the smallest unit of `currency`; USDC is 6dp.
        pricePerToken: t.pricePerToken,
        currency: t.currency,
        maxClaimableSupply: t.maxClaimableSupply,
        supplyClaimed: t.supplyClaimed,
        totalPurchases: t.totalPurchases,
        lazyMintedAt: t.lazyMintedAt,
      }));

      const filtered =
        params.maxPrice !== undefined
          ? priced.filter(
              (t) => Number(t.pricePerToken ?? "0") / 1e6 <= params.maxPrice!,
            )
          : priced;

      return {
        agentId: params.agentId,
        resultCount: filtered.length,
        listings: filtered,
        ...(params.query || params.assetType
          ? {
              note:
                "query/assetType filters were not applied: the drop subgraph indexes " +
                "no name or type — both live in each token's IPFS metadata. Fetch " +
                "baseURI to filter client-side.",
            }
          : {}),
      };
    },
  );

  /**
   * Agent: Request purchase of an asset (creates a purchase intent)
   * Actual on-chain purchase requires wallet signing — this stages the intent.
   */
  ipcMain.handle(
    "agent-market:request-purchase",
    async (
      _,
      params: {
        agentId: string;
        listingId: string;
        tokenId: string;
        reason: string;
        maxBudget: number;
      },
    ) => {
      logger.info(`Agent ${params.agentId} requesting purchase of listing ${params.listingId}`);

      // Save purchase intent for approval
      const intentDir = path.join(getBridgeStateDir(), "purchase-intents");
      await fs.ensureDir(intentDir);

      const intent = {
        id: `intent-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
        agentId: params.agentId,
        listingId: params.listingId,
        tokenId: params.tokenId,
        reason: params.reason,
        maxBudget: params.maxBudget,
        status: "pending_approval" as const,
        createdAt: new Date().toISOString(),
      };

      await fs.writeJson(path.join(intentDir, `${intent.id}.json`), intent, { spaces: 2 });

      logger.info(`Purchase intent created: ${intent.id}`);

      return {
        success: true,
        intentId: intent.id,
        status: "pending_approval",
        message: `Purchase intent for listing ${params.listingId} saved. Awaiting user approval for on-chain transaction.`,
      };
    },
  );

  /**
   * Agent: List a local asset on the marketplace
   */
  ipcMain.handle(
    "agent-market:request-listing",
    async (
      _,
      params: {
        agentId: string;
        localAssetId: string;
        assetType: AssetType;
        price: number;
        currency?: string;
        reason: string;
      },
    ) => {
      logger.info(`Agent ${params.agentId} requesting to list asset ${params.localAssetId}`);

      // Load the local asset to verify it exists
      const assetDir = path.join(getAssetsDir(), params.assetType);
      const metaPath = path.join(assetDir, `${params.localAssetId}.meta.json`);
      if (!(await fs.pathExists(metaPath))) {
        throw new Error(`Local asset not found: ${params.localAssetId}`);
      }
      const asset = await fs.readJson(metaPath);

      // Save listing intent
      const intentDir = path.join(getBridgeStateDir(), "listing-intents");
      await fs.ensureDir(intentDir);

      const intent = {
        id: `list-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
        agentId: params.agentId,
        localAssetId: params.localAssetId,
        assetType: params.assetType,
        assetName: asset.name,
        price: params.price,
        currency: params.currency || "MATIC",
        reason: params.reason,
        status: "pending_approval" as const,
        createdAt: new Date().toISOString(),
      };

      await fs.writeJson(path.join(intentDir, `${intent.id}.json`), intent, { spaces: 2 });

      return {
        success: true,
        intentId: intent.id,
        status: "pending_approval",
        message: `Listing intent for "${asset.name}" at ${params.price} ${intent.currency} saved. Awaiting user approval.`,
      };
    },
  );

  /**
   * Get all pending agent intents (purchases and listings)
   */
  ipcMain.handle("agent-market:pending-intents", async () => {
    const purchaseDir = path.join(getBridgeStateDir(), "purchase-intents");
    const listingDir = path.join(getBridgeStateDir(), "listing-intents");

    const purchases: any[] = [];
    const listings: any[] = [];

    if (await fs.pathExists(purchaseDir)) {
      const files = await fs.readdir(purchaseDir);
      for (const f of files) {
        if (f.endsWith(".json")) {
          const intent = await fs.readJson(path.join(purchaseDir, f));
          if (intent.status === "pending_approval") purchases.push(intent);
        }
      }
    }

    if (await fs.pathExists(listingDir)) {
      const files = await fs.readdir(listingDir);
      for (const f of files) {
        if (f.endsWith(".json")) {
          const intent = await fs.readJson(path.join(listingDir, f));
          if (intent.status === "pending_approval") listings.push(intent);
        }
      }
    }

    return {
      purchaseIntents: purchases,
      listingIntents: listings,
      total: purchases.length + listings.length,
    };
  });

  /**
   * Approve or reject a pending intent
   */
  ipcMain.handle(
    "agent-market:resolve-intent",
    async (
      _,
      params: {
        intentId: string;
        action: "approve" | "reject";
        reason?: string;
      },
    ) => {
      const purchaseDir = path.join(getBridgeStateDir(), "purchase-intents");
      const listingDir = path.join(getBridgeStateDir(), "listing-intents");

      // Search both directories
      for (const dir of [purchaseDir, listingDir]) {
        const filePath = path.join(dir, `${params.intentId}.json`);
        if (await fs.pathExists(filePath)) {
          const intent = await fs.readJson(filePath);
          intent.status = params.action === "approve" ? "approved" : "rejected";
          intent.resolvedAt = new Date().toISOString();
          intent.resolutionReason = params.reason;
          await fs.writeJson(filePath, intent, { spaces: 2 });

          logger.info(`Intent ${params.intentId} ${params.action}d`);
          return { success: true, intentId: params.intentId, status: intent.status };
        }
      }

      throw new Error(`Intent not found: ${params.intentId}`);
    },
  );

  /**
   * Agent: Check available AI models on marketplace
   */
  ipcMain.handle(
    "agent-market:browse-models",
    async (_, params?: { verified?: boolean; first?: number }) => {
      // Same repoint as agent-market:browse. `getAIModels` read an `aimodels`
      // entity that only ever existed on the retired MarketplaceV3 subgraph;
      // Arbitrum indexes tokens, not typed models. Verification status and
      // quality scores were properties of that schema and have no on-chain
      // equivalent here, so they are omitted rather than faked.
      const { listDrops } = await import("@/lib/joymarketplace/drop_subgraph");
      const { items } = await listDrops({
        pageSize: Math.min(params?.first ?? 50, 100),
        orderBy: "totalPurchases",
        orderDirection: "desc",
      });

      return {
        count: items.length,
        models: items.map((t) => ({
          tokenId: t.tokenId,
          contract: (t as { contract?: string }).contract,
          baseURI: t.baseURI,
          pricePerToken: t.pricePerToken,
          currency: t.currency,
          totalPurchases: t.totalPurchases,
          supplyClaimed: t.supplyClaimed,
        })),
        note:
          "Asset type, verification and quality score are not indexed on-chain — " +
          "read each token's baseURI metadata for those. Results are ordered by " +
          "purchase count.",
      };
    },
  );

  /**
   * Agent: Check what licenses the user already has
   */
  ipcMain.handle(
    "agent-market:my-licenses",
    async (_, walletAddress: string) => {
      if (!walletAddress) throw new Error("walletAddress required");
      // A "licence" is a claimed edition. The old `getUserLicenses` read a
      // MarketplaceV3 entity that no longer exists; claims are what the drop
      // subgraph actually records.
      const { listClaimsByBuyer } = await import("@/lib/joymarketplace/drop_subgraph");
      const claims = await listClaimsByBuyer({ buyer: walletAddress, pageSize: 100 });
      return {
        count: claims.length,
        licenses: claims.map((c) => ({
          tokenId: c.tokenId,
          contract: (c as { contract?: string }).contract,
          quantity: c.quantity,
          claimedAt: c.timestamp,
          txHash: c.txHash,
        })),
      };
    },
  );

  /**
   * Agent: Get purchase history
   */
  ipcMain.handle(
    "agent-market:purchase-history",
    async (_, walletAddress: string) => {
      if (!walletAddress) throw new Error("walletAddress required");
      const purchases = await getUserPurchases(walletAddress);
      return {
        count: purchases.length,
        purchases: purchases.map((p) => ({
          tokenId: p.tokenId,
          quantity: p.quantity,
          timestamp: p.timestamp,
          txHash: p.txHash,
        })),
      };
    },
  );

  logger.info("On-chain asset bridge handlers registered");
}
