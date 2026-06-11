/**
 * JoyMarketplace IPC Handlers
 *
 * Fire-and-forget architecture:
 *   1. Verify API key via joy-create-verify edge function
 *   2. Pin to IPFS (Pinata / Helia)
 *   3. Lazy-mint DropERC1155 on Polygon Amoy
 *   4. List on MarketplaceV3
 *   5. Goldsky subgraphs index it → marketplace UI picks it up
 *
 * No backend publish/browse/earnings endpoints — those read from subgraphs.
 */

import { ipcMain, app } from "electron";
import { ethers } from "ethers";
import { db } from "@/db";
import { apps, skills, agents } from "@/db/schema";
import { eq } from "drizzle-orm";
import * as fs from "fs-extra";
import * as path from "path";
import log from "electron-log";
import AdmZip from "adm-zip";
import { getJoyAppPath } from "../../paths/paths";
import { JOYMARKETPLACE_API } from "@/config/joymarketplace";
import {
  getMarketplaceAssets,
  getMarketplaceListings,
  getMarketplaceStats,
  getUserDomains,
} from "@/lib/subgraph_client";
import { jcnKeyManager } from "@/lib/jcn_key_manager";
import { ERC8004_RPC, DEFAULT_ERC8004_CHAIN, type Erc8004ChainId } from "@/config/erc8004";
import type { GlueChainId } from "@/config/glue";
import { getAgent } from "@/lib/onchain/erc8004_client";
import {
  publishSkillToAgent,
  type PublishSkillResult,
  type AuthorSkillInput,
} from "@/lib/onchain/skill_authoring";
import { skillRowToAuthorInput, type SkillListingOptions } from "@/lib/onchain/skill_listing";
import {
  agentRowToAuthorInput,
  type AgentListingOptions,
  type AgentRow,
  type RuntimeEntityKind,
} from "@/lib/onchain/entity_listing";
import { bridgeIdentityToA2a, type BridgeResult } from "@/lib/onchain/lra_a2a_bridge";
import type { A2ACurrency } from "@/db/a2a_schema";
import type { CreateListingInput } from "@/lib/a2a_economy";
import type {
  PublishAppRequest,
  PublishAppResponse,
  MarketplaceCredentials,
  DeploymentStatus,
  AppBundle,
  PublishModelRequest,
  ModelBundle,
  BundleFile,
} from "@/types/marketplace_types";

const logger = log.scope("marketplace_handlers");

const MARKETPLACE_WEB_URL = JOYMARKETPLACE_API.webUrl;

const LRA_SUPPORTED_CHAINS: readonly Erc8004ChainId[] = ["arbitrumSepolia", "arbitrumOne"];

function resolveLraChain(value: unknown): Erc8004ChainId {
  if (typeof value === "string" && (LRA_SUPPORTED_CHAINS as readonly string[]).includes(value)) {
    return value as Erc8004ChainId;
  }
  if (value == null) return DEFAULT_ERC8004_CHAIN;
  throw new Error(`chain must be one of ${LRA_SUPPORTED_CHAINS.join(", ")}, got ${String(value)}`);
}

async function loadLraWallet(chain: Erc8004ChainId): Promise<ethers.Wallet> {
  await jcnKeyManager.initialize();
  const keys = await jcnKeyManager.listKeys("chain");
  const active = keys.find((k) => k.active && k.algorithm === "secp256k1");
  if (!active) {
    throw new Error("no active chain (secp256k1) key in jcnKeyManager — import one in Settings");
  }
  const pk = await jcnKeyManager.getPrivateKey(active.keyId);
  if (!pk) throw new Error("active chain key has no private material");
  const provider = new ethers.JsonRpcProvider(ERC8004_RPC[chain]);
  const hex = pk.toString("hex");
  return new ethers.Wallet(hex.startsWith("0x") ? hex : `0x${hex}`, provider);
}

export interface ListSkillParams {
  /** Local `skills.id` to list. */
  skillId: number;
  chain?: string;
  /**
   * On-chain ERC-8004 agentId whose card the skill is attached to. Optional
   * when `localAgentId` resolves to an agent already linked on-chain.
   */
  erc8004AgentId?: string;
  /**
   * Local `agents.id`. When provided, the agent's `erc8004AgentId`/`modelId`
   * are used as fallbacks and the agent is bridged into the A2A economy.
   */
  localAgentId?: number;
  /** Name for a freshly-built agent card when the agent has none yet. */
  cardName?: string;
  /** Adapter options (modelId / MCP tool allow-list / sandbox limits). */
  options?: SkillListingOptions;
  /** Create an A2A listing too (defaults to true when `localAgentId` is set). */
  bridgeToA2a?: boolean;
  pricing?: {
    pricingModel?: CreateListingInput["pricingModel"];
    priceAmount?: string;
    currency?: A2ACurrency;
  };
}

export interface ListSkillResult {
  skill: PublishSkillResult;
  bridge?: BridgeResult;
}

export interface ListEntityParams {
  /** Which runtime-bearing local entity is being listed. */
  kind: Extract<RuntimeEntityKind, "agent" | "app">;
  /** `agents.id` (kind="agent") or `apps.id` (kind="app"). */
  entityId: number;
  chain?: string;
  /**
   * On-chain ERC-8004 agentId. Optional when the resolved local agent is
   * already linked on-chain (its `erc8004AgentId`).
   */
  erc8004AgentId?: string;
  /** Card name override (defaults to the agent/app name). */
  cardName?: string;
  /** Prompt-agent adapter overrides (model / prompt / limits). */
  agentOptions?: AgentListingOptions;
  /** Mirror into the A2A economy (defaults to true). */
  bridgeToA2a?: boolean;
  pricing?: ListSkillParams["pricing"];
}

export interface ListEntityResult {
  kind: RuntimeEntityKind;
  /** The local `agents.id` that was actually published. */
  resolvedAgentId: number;
  skill: PublishSkillResult;
  bridge?: BridgeResult;
}

/**
 * Shared LRA publish core used by `marketplace:list-skill` and
 * `marketplace:list-entity`: author + pin the runtime, attach it to the
 * ERC-8004 agent card, backfill the local identity link, and (optionally)
 * mirror the agent into the A2A economy.
 */
async function publishRuntimeAsset(args: {
  chain: Erc8004ChainId;
  erc8004AgentId: string;
  agentRow?: AgentRow;
  skillInput: AuthorSkillInput;
  cardName: string;
  description?: string | null;
  bridgeToA2a: boolean;
  pricing?: ListSkillParams["pricing"];
}): Promise<{ skill: PublishSkillResult; bridge?: BridgeResult }> {
  const wallet = await loadLraWallet(args.chain);
  const published = await publishSkillToAgent(wallet, {
    chain: args.chain,
    agentId: args.erc8004AgentId,
    skill: args.skillInput,
    cardName: args.cardName,
  });

  // Backfill the identity link on the owning agent.
  if (args.agentRow && !args.agentRow.erc8004AgentId) {
    await db
      .update(agents)
      .set({ erc8004AgentId: args.erc8004AgentId, erc8004Chain: args.chain, updatedAt: new Date() })
      .where(eq(agents.id, args.agentRow.id));
  }

  let bridge: BridgeResult | undefined;
  if (args.agentRow && args.bridgeToA2a) {
    const agent = await getAgent(args.chain, args.erc8004AgentId);
    bridge = await bridgeIdentityToA2a({
      localAgentId: args.agentRow.id,
      erc8004AgentId: args.erc8004AgentId,
      chain: args.chain as GlueChainId,
      agentAddress: agent.agentAddress,
      skillCid: published.skillCid,
      listingName: args.cardName,
      description: args.description ?? undefined,
      pricing: args.pricing,
    });
  }
  return { skill: published, bridge };
}

// Store credentials in memory (should be persisted in settings)
let marketplaceCredentials: MarketplaceCredentials | null = null;

/**
 * Get the marketplace credentials file path
 */
function getCredentialsPath(): string {
  return path.join(app.getPath("userData"), "marketplace-credentials.json");
}

/**
 * Load marketplace credentials from disk
 */
async function loadCredentials(): Promise<MarketplaceCredentials | null> {
  try {
    const credPath = getCredentialsPath();
    if (await fs.pathExists(credPath)) {
      const data = await fs.readJson(credPath);
      marketplaceCredentials = data;
      return data;
    }
  } catch (error) {
    logger.error("Failed to load marketplace credentials:", error);
  }
  return null;
}

/**
 * Save marketplace credentials to disk
 */
async function saveCredentials(credentials: MarketplaceCredentials): Promise<void> {
  try {
    const credPath = getCredentialsPath();
    await fs.writeJson(credPath, credentials, { spaces: 2 });
    marketplaceCredentials = credentials;
  } catch (error) {
    logger.error("Failed to save marketplace credentials:", error);
    throw error;
  }
}

/**
 * Call the joy-create-verify edge function to verify an API key.
 * Returns { ok, user_id, scopes, network } on success.
 */
async function verifyApiKey(apiKey: string): Promise<{
  ok: boolean;
  user_id: string;
  scopes: string[];
  network: {
    chain: string;
    chain_id: number;
    drop_subgraph: string;
    marketplace_subgraph: string;
    stores_subgraph: string;
  };
}> {
  const url = `${JOYMARKETPLACE_API.baseUrl}${JOYMARKETPLACE_API.endpoints.verify}`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
      "x-joy-api-key": apiKey,
      "apikey": JOYMARKETPLACE_API.supabaseAnonKey,
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Verification failed (${response.status}): ${body}`);
  }

  const data = await response.json();
  if (!data.ok) {
    throw new Error("API key verification returned ok=false");
  }
  return data;
}

/**
 * Bundle an app for upload
 */
async function bundleApp(appId: number): Promise<AppBundle> {
  const appRecord = await db.query.apps.findFirst({
    where: eq(apps.id, appId),
  });

  if (!appRecord) {
    throw new Error("App not found");
  }

  const appPath = getJoyAppPath(appRecord.path);
  
  if (!await fs.pathExists(appPath)) {
    throw new Error("App directory not found");
  }

  const bundle: AppBundle = {
    appId,
    appName: appRecord.name,
    files: [],
    totalSize: 0,
    createdAt: new Date().toISOString(),
  };

  // Files/folders to exclude from bundle
  const excludePatterns = [
    "node_modules",
    ".git",
    ".env",
    ".env.local",
    "dist",
    "build",
    ".next",
    ".nuxt",
    ".cache",
  ];

  async function collectFiles(dir: string, relativePath: string = "") {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relPath = path.join(relativePath, entry.name);
      
      // Skip excluded patterns
      if (excludePatterns.some(pattern => entry.name === pattern || entry.name.startsWith("."))) {
        continue;
      }

      if (entry.isDirectory()) {
        await collectFiles(fullPath, relPath);
      } else if (entry.isFile()) {
        try {
          const content = await fs.readFile(fullPath);
          const base64Content = content.toString("base64");
          bundle.files.push({
            path: relPath.replace(/\\/g, "/"),
            content: base64Content,
            size: content.length,
          });
          bundle.totalSize += content.length;
        } catch (error) {
          logger.warn(`Failed to read file ${fullPath}:`, error);
        }
      }
    }
  }

  await collectFiles(appPath);
  
  logger.info(`Bundled app ${appRecord.name}: ${bundle.files.length} files, ${(bundle.totalSize / 1024 / 1024).toFixed(2)} MB`);
  
  return bundle;
}

/**
 * Create a ZIP file from the app
 */
export async function createAppZip(appId: number): Promise<string> {
  const appRecord = await db.query.apps.findFirst({
    where: eq(apps.id, appId),
  });

  if (!appRecord) {
    throw new Error("App not found");
  }

  const appPath = getJoyAppPath(appRecord.path);
  const tempDir = path.join(app.getPath("temp"), "joycreate-exports");
  await fs.ensureDir(tempDir);
  
  const zipPath = path.join(tempDir, `${appRecord.name.replace(/[^a-zA-Z0-9]/g, "-")}-${Date.now()}.zip`);
  
  const zip = new AdmZip();
  
  const excludePatterns = [
    "node_modules",
    ".git",
    ".env",
    ".env.local",
    "dist",
    "build",
    ".next",
    ".cache",
  ];

  async function addFilesToZip(dir: string, zipPath: string = "") {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const entryZipPath = zipPath ? `${zipPath}/${entry.name}` : entry.name;
      
      if (excludePatterns.some(pattern => entry.name === pattern)) {
        continue;
      }

      if (entry.isDirectory()) {
        await addFilesToZip(fullPath, entryZipPath);
      } else if (entry.isFile()) {
        try {
          const content = await fs.readFile(fullPath);
          zip.addFile(entryZipPath, content);
        } catch (error) {
          logger.warn(`Failed to add file ${fullPath} to zip:`, error);
        }
      }
    }
  }

  await addFilesToZip(appPath);
  zip.writeZip(zipPath);
  
  logger.info(`Created ZIP for app ${appRecord.name}: ${zipPath}`);
  
  return zipPath;
}

/**
 * Bundle a trained model/adapter for upload
 */
async function bundleModel(adapterPath: string, name: string, baseModelId: string): Promise<ModelBundle> {
  if (!await fs.pathExists(adapterPath)) {
    throw new Error("Adapter directory not found");
  }

  const bundle: ModelBundle = {
    name,
    baseModelId,
    files: [],
    totalSize: 0,
    metadata: {},
    createdAt: new Date().toISOString(),
  };

  // Read adapter_config.json for metadata if present
  const configPath = path.join(adapterPath, "adapter_config.json");
  if (await fs.pathExists(configPath)) {
    try {
      const config = await fs.readJson(configPath);
      bundle.metadata = {
        peft_type: config.peft_type || "unknown",
        r: String(config.r || ""),
        lora_alpha: String(config.lora_alpha || ""),
        base_model_name_or_path: config.base_model_name_or_path || baseModelId,
      };
    } catch {
      // ignore parse errors
    }
  }

  // Collect all files in the adapter directory
  const entries = await fs.readdir(adapterPath, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const fullPath = path.join(adapterPath, entry.name);
    try {
      const content = await fs.readFile(fullPath);
      const file: BundleFile = {
        path: entry.name,
        content: content.toString("base64"),
        size: content.length,
      };
      bundle.files.push(file);
      bundle.totalSize += content.length;
    } catch (error) {
      logger.warn(`Failed to read adapter file ${fullPath}:`, error);
    }
  }

  logger.info(`Bundled model ${name}: ${bundle.files.length} files, ${(bundle.totalSize / 1024 / 1024).toFixed(2)} MB`);
  return bundle;
}

/**
 * Register all marketplace IPC handlers
 */
export function registerMarketplaceHandlers() {
  // Check marketplace connection status
  ipcMain.handle("marketplace:status", async () => {
    try {
      await loadCredentials();
      
      if (!marketplaceCredentials?.apiKey) {
        return {
          connected: false,
          profile: null,
        };
      }

      // Re-verify credentials with the edge function
      const data = await verifyApiKey(marketplaceCredentials.apiKey);

      // Refresh domain list
      let domains: string[] = [];
      try {
        const domainRegs = await getUserDomains(data.user_id);
        domains = domainRegs.map((d) => d.fullName || `${d.name}.joy`);
      } catch {
        // Use cached domains if subgraph is unreachable
        domains = marketplaceCredentials.domains ?? [];
      }
      
      return {
        connected: true,
        profile: {
          id: data.user_id,
          scopes: data.scopes,
          network: data.network,
          hasJoyDomain: domains.length > 0,
          domains,
        },
      };
    } catch (error) {
      logger.error("Failed to check marketplace status:", error);
      return {
        connected: false,
        profile: null,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  });

  // Connect to marketplace (authenticate via joy-create-verify)
  ipcMain.handle("marketplace:connect", async (_, apiKey: string) => {
    try {
      const data = await verifyApiKey(apiKey);
      
      // Look up .joy domains owned by this user via the stores subgraph
      let domains: string[] = [];
      try {
        const domainRegs = await getUserDomains(data.user_id);
        domains = domainRegs.map((d) => d.fullName || `${d.name}.joy`);
      } catch (err) {
        logger.warn("Failed to fetch .joy domains (non-fatal):", err);
      }

      const credentials: MarketplaceCredentials = {
        apiKey,
        publisherId: data.user_id,
        scopes: data.scopes,
        network: data.network,
        hasJoyDomain: domains.length > 0,
        domains,
      };
      
      await saveCredentials(credentials);
      
      logger.info(`Connected to JoyMarketplace (user=${data.user_id}, scopes=${data.scopes.join(",")}, domains=${domains.length})`);
      
      return {
        success: true,
        userId: data.user_id,
        scopes: data.scopes,
        network: data.network,
        hasJoyDomain: domains.length > 0,
        domains,
      };
    } catch (error) {
      logger.error("Failed to connect to marketplace:", error);
      throw error;
    }
  });

  // Disconnect from marketplace
  ipcMain.handle("marketplace:disconnect", async () => {
    try {
      const credPath = getCredentialsPath();
      if (await fs.pathExists(credPath)) {
        await fs.remove(credPath);
      }
      marketplaceCredentials = null;
      return { success: true };
    } catch (error) {
      logger.error("Failed to disconnect from marketplace:", error);
      throw error;
    }
  });

  // Get publisher profile — re-verify to get fresh scopes/network
  ipcMain.handle("marketplace:get-profile", async () => {
    await loadCredentials();
    if (!marketplaceCredentials?.apiKey) {
      throw new Error("Not connected to JoyMarketplace");
    }
    const data = await verifyApiKey(marketplaceCredentials.apiKey);
    return {
      id: data.user_id,
      scopes: data.scopes,
      network: data.network,
    };
  });

  // Get published assets — read from Goldsky marketplace subgraph
  ipcMain.handle("marketplace:list-assets", async () => {
    await loadCredentials();
    if (!marketplaceCredentials?.publisherId) {
      throw new Error("Not connected to JoyMarketplace");
    }
    // Query subgraph for assets created by this publisher
    return getMarketplaceAssets({ creator: marketplaceCredentials.publisherId });
  });

  // Get single asset details — read from subgraph
  ipcMain.handle("marketplace:get-asset", async (_, assetId: string) => {
    const assets = await getMarketplaceAssets();
    const asset = assets.find((a) => a.id === assetId || a.tokenId === assetId);
    if (!asset) throw new Error(`Asset not found: ${assetId}`);
    return asset;
  });

  // Publish app — fire-and-forget: bundle → IPFS → on-chain.
  // The actual IPFS pinning + lazy-mint + MarketplaceV3 listing is driven
  // by the renderer's CreateAssetWizard (Thirdweb SDK). This handler just
  // prepares the bundle so the wizard has the files to pin.
  ipcMain.handle("marketplace:publish", async (_, request: PublishAppRequest): Promise<PublishAppResponse> => {
    try {
      logger.info(`Bundling app ${request.appId} for marketplace publish...`);
      const bundle = await bundleApp(request.appId);

      // Return the bundle metadata — the renderer will pin to IPFS,
      // lazy-mint on DropERC1155, and list on MarketplaceV3.
      return {
        success: true,
        status: "pending-review",
        message: `App bundled (${bundle.files.length} files, ${(bundle.totalSize / 1024 / 1024).toFixed(1)} MB). Ready for on-chain publish.`,
        assetUrl: undefined,
        assetId: undefined,
      };
    } catch (error) {
      logger.error("Failed to bundle app for publish:", error);
      return {
        success: false,
        status: "rejected",
        message: error instanceof Error ? error.message : "Unknown error",
      };
    }
  });

  // Publish trained model/adapter — same fire-and-forget pattern
  ipcMain.handle("marketplace:publish-model", async (_, request: PublishModelRequest): Promise<PublishAppResponse> => {
    try {
      logger.info(`Bundling model ${request.name} for marketplace publish...`);
      const bundle = await bundleModel(request.adapterPath, request.name, request.baseModelId);

      return {
        success: true,
        status: "pending-review",
        message: `Model bundled (${bundle.files.length} files, ${(bundle.totalSize / 1024 / 1024).toFixed(1)} MB). Ready for on-chain publish.`,
        assetUrl: undefined,
        assetId: undefined,
      };
    } catch (error) {
      logger.error("Failed to bundle model for publish:", error);
      return {
        success: false,
        status: "rejected",
        message: error instanceof Error ? error.message : "Unknown error",
      };
    }
  });

  // Update/unpublish are on-chain operations — not backend calls
  ipcMain.handle("marketplace:update-asset", async () => {
    throw new Error("Asset updates are performed on-chain via the MarketplaceV3 contract. Use the CreateAssetWizard.");
  });

  ipcMain.handle("marketplace:unpublish", async () => {
    throw new Error("Unpublishing is performed on-chain via the MarketplaceV3 contract.");
  });

  // Pre-flight mint eligibility — verifies wallet owns a .joy domain
  // before the renderer attempts a JoyCreatorGate.mint() transaction.
  ipcMain.handle("marketplace:check-mint-eligibility", async (_, walletAddress: string) => {
    if (!walletAddress) {
      throw new Error("Wallet address is required for mint eligibility check");
    }

    const domainRegs = await getUserDomains(walletAddress);
    const domains = domainRegs.map((d) => d.fullName || `${d.name}.joy`);
    const eligible = domains.length > 0;

    if (!eligible) {
      logger.warn(`Mint pre-flight failed: wallet ${walletAddress} owns no .joy domains`);
    }

    return {
      eligible,
      domains,
      reason: eligible
        ? undefined
        : "You must own a .joy domain to mint on the JoyCreate platform. Register one at joymarketplace.io.",
    };
  });

  // Get earnings — read from Goldsky marketplace subgraph
  ipcMain.handle("marketplace:earnings", async () => {
    await loadCredentials();
    const stats = await getMarketplaceStats();
    const listings = marketplaceCredentials?.publisherId
      ? await getMarketplaceListings({ seller: marketplaceCredentials.publisherId })
      : [];

    const totalEarnings = listings.reduce((sum, l) => sum + Number(l.totalPaid || 0), 0);

    // Compute month-over-month earnings from on-chain sale timestamps.
    // `soldAt` is a unix timestamp in seconds (subgraph block time).
    const now = new Date();
    const startOfThisMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1).getTime();

    const soldListings = listings.filter((l) => l.buyer && l.soldAt);
    const earningsInRange = (startMs: number, endMs: number) =>
      soldListings.reduce((sum, l) => {
        const soldMs = Number(l.soldAt) * 1000;
        return soldMs >= startMs && soldMs < endMs ? sum + Number(l.totalPaid || 0) : sum;
      }, 0);

    const thisMonth = earningsInRange(startOfThisMonth, Number.POSITIVE_INFINITY);
    const lastMonth = earningsInRange(startOfLastMonth, startOfThisMonth);

    return {
      totalEarnings,
      thisMonth,
      lastMonth,
      pendingPayout: 0,
      salesCount: listings.filter((l) => l.buyer).length,
      topAssets: listings
        .filter((l) => l.buyer)
        .slice(0, 10)
        .map((l) => ({
          assetId: l.id,
          name: l.asset?.name ?? l.listingId,
          earnings: Number(l.totalPaid || 0),
          sales: 1,
        })),
      marketplaceStats: stats,
    };
  });

  // Export app as ZIP for manual upload
  ipcMain.handle("marketplace:export-zip", async (_, appId: number) => {
    try {
      const zipPath = await createAppZip(appId);
      return {
        success: true,
        path: zipPath,
      };
    } catch (error) {
      logger.error("Failed to export app as ZIP:", error);
      throw error;
    }
  });

  // Get deployment status for an app
  ipcMain.handle("marketplace:deployment-status", async (_, appId: number): Promise<DeploymentStatus> => {
    // For now, return idle status
    // In production, this would check actual deployment status
    return {
      target: "joymarketplace",
      status: "idle",
    };
  });

  // Open marketplace in browser
  ipcMain.handle("marketplace:open", async (_, path?: string) => {
    const { shell } = await import("electron");
    const url = path ? `${MARKETPLACE_WEB_URL}${path}` : MARKETPLACE_WEB_URL;
    await shell.openExternal(url);
    return { success: true };
  });

  // Get marketplace URL
  ipcMain.handle("marketplace:get-url", async () => {
    return {
      apiUrl: JOYMARKETPLACE_API.baseUrl,
      webUrl: MARKETPLACE_WEB_URL,
    };
  });

  // List a local skill as a Licensed Runtime Asset (author + pin + attach to an
  // ERC-8004 agent card) and optionally mirror its owning agent into the A2A
  // economy so other agents can discover → quote → escrow → invoke it.
  ipcMain.handle(
    "marketplace:list-skill",
    async (_e, params: ListSkillParams): Promise<ListSkillResult> => {
      if (!Number.isInteger(params?.skillId) || params.skillId <= 0) {
        throw new Error("skillId must be a positive integer");
      }
      const chain = resolveLraChain(params.chain);

      const [skillRow] = await db.select().from(skills).where(eq(skills.id, params.skillId)).limit(1);
      if (!skillRow) throw new Error(`skill ${params.skillId} not found`);

      // Resolve the owning local agent (for identity link + model fallback).
      let agentRow: typeof agents.$inferSelect | undefined;
      if (params.localAgentId != null) {
        if (!Number.isInteger(params.localAgentId) || params.localAgentId <= 0) {
          throw new Error("localAgentId must be a positive integer");
        }
        [agentRow] = await db
          .select()
          .from(agents)
          .where(eq(agents.id, params.localAgentId))
          .limit(1);
        if (!agentRow) throw new Error(`agent ${params.localAgentId} not found`);
      }

      const erc8004AgentId = params.erc8004AgentId ?? agentRow?.erc8004AgentId ?? undefined;
      if (!erc8004AgentId) {
        throw new Error(
          "erc8004AgentId is required (pass it directly or via a localAgentId already linked on-chain)",
        );
      }

      // Adapter options — fall back to the owning agent's model for prompt/tool skills.
      const options: SkillListingOptions = {
        ...params.options,
        modelId: params.options?.modelId ?? agentRow?.modelId ?? undefined,
      };
      const skillInput = skillRowToAuthorInput(skillRow, options);

      const { skill: published, bridge } = await publishRuntimeAsset({
        chain,
        erc8004AgentId,
        agentRow,
        skillInput,
        cardName: params.cardName ?? skillRow.name,
        description: skillRow.description,
        bridgeToA2a: agentRow != null && params.bridgeToA2a !== false,
        pricing: params.pricing,
      });

      // Persist the local publish state.
      await db
        .update(skills)
        .set({
          publishStatus: "published",
          marketplaceId: published.skillCid,
          updatedAt: new Date(),
        })
        .where(eq(skills.id, params.skillId));

      logger.info(
        `marketplace:list-skill skill=${params.skillId} → agent ${erc8004AgentId} ` +
          `(skillCid=${published.skillCid}, bridged=${bridge ? bridge.listingId : "no"})`,
      );
      return { skill: published, bridge };
    },
  );

  // List a runtime-bearing entity (an agent, or an app via its owning agent) as
  // a Licensed Runtime Asset. Agents are declarative model + system-prompt
  // runtimes, so they map onto the prompt-agent bundle kind.
  ipcMain.handle(
    "marketplace:list-entity",
    async (_e, params: ListEntityParams): Promise<ListEntityResult> => {
      if (params?.kind !== "agent" && params?.kind !== "app") {
        throw new Error('kind must be "agent" or "app"');
      }
      if (!Number.isInteger(params?.entityId) || params.entityId <= 0) {
        throw new Error("entityId must be a positive integer");
      }
      const chain = resolveLraChain(params.chain);

      // Resolve the local agent to publish.
      let agentRow: AgentRow | undefined;
      if (params.kind === "agent") {
        [agentRow] = await db.select().from(agents).where(eq(agents.id, params.entityId)).limit(1);
        if (!agentRow) throw new Error(`agent ${params.entityId} not found`);
      } else {
        const [appRow] = await db.select().from(apps).where(eq(apps.id, params.entityId)).limit(1);
        if (!appRow) throw new Error(`app ${params.entityId} not found`);
        [agentRow] = await db
          .select()
          .from(agents)
          .where(eq(agents.appId, appRow.id))
          .limit(1);
        if (!agentRow) {
          throw new Error(
            `app ${params.entityId} (${appRow.name}) has no agent to list — create an agent for it first`,
          );
        }
      }

      const erc8004AgentId = params.erc8004AgentId ?? agentRow.erc8004AgentId ?? undefined;
      if (!erc8004AgentId) {
        throw new Error(
          "erc8004AgentId is required (pass it directly or link the agent on-chain first)",
        );
      }

      const skillInput = agentRowToAuthorInput(agentRow, params.agentOptions);
      const cardName = params.cardName ?? agentRow.name;

      const { skill: published, bridge } = await publishRuntimeAsset({
        chain,
        erc8004AgentId,
        agentRow,
        skillInput,
        cardName,
        description: agentRow.description,
        bridgeToA2a: params.bridgeToA2a !== false,
        pricing: params.pricing,
      });

      // Persist the local publish state on the agent.
      await db
        .update(agents)
        .set({
          publishStatus: "published",
          marketplaceId: published.skillCid,
          publishedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(agents.id, agentRow.id));

      logger.info(
        `marketplace:list-entity ${params.kind}=${params.entityId} → agent ${erc8004AgentId} ` +
          `(localAgent=${agentRow.id}, skillCid=${published.skillCid}, bridged=${bridge ? bridge.listingId : "no"})`,
      );
      return { kind: params.kind, resolvedAgentId: agentRow.id, skill: published, bridge };
    },
  );

  logger.info("Marketplace IPC handlers registered");
}
