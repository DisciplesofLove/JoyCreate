/**
 * Decentralized Deployment IPC Handlers
 * Handles deployments to 4everland, Fleek, IPFS, Arweave, and other Web3 platforms
 */

import { ipcMain } from "electron";
import * as fs from "fs/promises";
import * as path from "path";
import { app } from "electron";
import log from "electron-log";
import { getJoyAppPath } from "@/paths/paths";
import { guarded } from "@/ipc/utils/guarded_handle";
import { db } from "../../db";
import { apps } from "../../db/schema";
import { eq } from "drizzle-orm";
import type {
  DecentralizedPlatform,
  PlatformCredentials,
  DecentralizedDeployRequest,
  DecentralizedDeployResult,
  DecentralizedDeployment,
  DecentralizedBuildConfig,
  IPFSPinStatus,
  PLATFORM_CONFIGS,
} from "../../types/decentralized_deploy";

const logger = log.scope("decentralized_deploy_handlers");

// ============================================================================
// Constants & Configuration
// ============================================================================

const DEPLOY_DATA_DIR = path.join(app.getPath("userData"), "decentralized-deployments");
const CREDENTIALS_FILE = path.join(DEPLOY_DATA_DIR, "credentials.json");
const DEPLOYMENTS_FILE = path.join(DEPLOY_DATA_DIR, "deployments.json");

// Platform API endpoints
const API_ENDPOINTS = {
  "4everland": "https://api.4everland.org",
  "fleek": "https://api.fleek.xyz",
  "ipfs-pinata": "https://api.pinata.cloud",
  "ipfs-infura": "https://ipfs.infura.io:5001",
  "ipfs-web3storage": "https://api.web3.storage",
  "arweave": "https://arweave.net",
  "filecoin": "https://api.estuary.tech",
  "skynet": "https://siasky.net",
  "spheron": "https://api.spheron.network",
  "filebase": "https://api.filebase.io",
};

// ============================================================================
// Initialization
// ============================================================================

async function ensureDirectories(): Promise<void> {
  await fs.mkdir(DEPLOY_DATA_DIR, { recursive: true });
}

// ============================================================================
// Credential Management
// ============================================================================

async function loadCredentials(): Promise<Record<DecentralizedPlatform, PlatformCredentials>> {
  await ensureDirectories();
  try {
    const data = await fs.readFile(CREDENTIALS_FILE, "utf-8");
    return JSON.parse(data);
  } catch {
    return {} as Record<DecentralizedPlatform, PlatformCredentials>;
  }
}

async function saveCredentials(
  credentials: Record<DecentralizedPlatform, PlatformCredentials>
): Promise<void> {
  await ensureDirectories();
  await fs.writeFile(CREDENTIALS_FILE, JSON.stringify(credentials, null, 2));
}

async function getCredentials(platform: DecentralizedPlatform): Promise<PlatformCredentials | null> {
  const creds = await loadCredentials();
  return creds[platform] || null;
}

// ============================================================================
// Deployment Storage
// ============================================================================

async function loadDeployments(): Promise<DecentralizedDeployment[]> {
  await ensureDirectories();
  try {
    const data = await fs.readFile(DEPLOYMENTS_FILE, "utf-8");
    return JSON.parse(data);
  } catch {
    return [];
  }
}

async function saveDeployments(deployments: DecentralizedDeployment[]): Promise<void> {
  await ensureDirectories();
  await fs.writeFile(DEPLOYMENTS_FILE, JSON.stringify(deployments, null, 2));
}

async function addDeployment(deployment: DecentralizedDeployment): Promise<void> {
  const deployments = await loadDeployments();
  deployments.unshift(deployment);
  await saveDeployments(deployments);
}

async function updateDeployment(
  id: string,
  updates: Partial<DecentralizedDeployment>
): Promise<void> {
  const deployments = await loadDeployments();
  const index = deployments.findIndex((d) => d.id === id);
  if (index !== -1) {
    deployments[index] = { ...deployments[index], ...updates, updatedAt: Date.now() };
    await saveDeployments(deployments);
  }
}

// ============================================================================
// Build & Package App
// ============================================================================

async function buildApp(
  appPath: string,
  config: DecentralizedBuildConfig
): Promise<{ success: boolean; outputPath: string; logs: string[] }> {
  const logs: string[] = [];
  const outputPath = path.join(appPath, config.outputDir);

  try {
    const { exec } = await import("child_process");
    const { promisify } = await import("util");
    const execAsync = promisify(exec);

    // Install dependencies
    if (config.installCommand) {
      logs.push(`Running: ${config.installCommand}`);
      const { stdout, stderr } = await execAsync(config.installCommand, { cwd: appPath });
      if (stdout) logs.push(stdout);
      if (stderr) logs.push(stderr);
    }

    // Build the app
    logs.push(`Running: ${config.buildCommand}`);
    const { stdout, stderr } = await execAsync(config.buildCommand, {
      cwd: appPath,
      env: { ...process.env, ...config.envVars },
    });
    if (stdout) logs.push(stdout);
    if (stderr) logs.push(stderr);

    // Check if output directory exists
    await fs.access(outputPath);
    logs.push(`Build successful! Output: ${outputPath}`);

    return { success: true, outputPath, logs };
  } catch (error) {
    logs.push(`Build failed: ${error}`);
    return { success: false, outputPath, logs };
  }
}

// ============================================================================
// Platform-Specific Deployments
// ============================================================================

// 4EVERLAND Deployment
async function deployTo4Everland(
  outputPath: string,
  credentials: PlatformCredentials,
  metadata?: any
): Promise<DecentralizedDeployResult> {
  const FormData = (await import("form-data")).default;
  const formData = new FormData();
  
  // Read all files from output directory and add to form
  const files = await getAllFiles(outputPath);
  for (const file of files) {
    const relativePath = path.relative(outputPath, file);
    const content = await fs.readFile(file);
    formData.append("file", content, { filepath: relativePath });
  }

  try {
    const response = await fetch(`${API_ENDPOINTS["4everland"]}/hosting/deploy`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credentials.apiKey}`,
      },
      body: formData as any,
    });

    if (!response.ok) {
      throw new Error(`4EVERLAND deployment failed: ${response.statusText}`);
    }

    const result = await response.json();
    
    return {
      success: true,
      platform: "4everland",
      deploymentId: result.deploymentId || result.id,
      cid: result.cid,
      url: `https://${result.cid}.ipfs.4everland.io`,
      gatewayUrls: [
        `https://${result.cid}.ipfs.4everland.io`,
        `https://ipfs.io/ipfs/${result.cid}`,
        `https://dweb.link/ipfs/${result.cid}`,
      ],
      timestamp: Date.now(),
    };
  } catch (error) {
    return {
      success: false,
      platform: "4everland",
      deploymentId: "",
      url: "",
      gatewayUrls: [],
      timestamp: Date.now(),
      error: String(error),
    };
  }
}

// Fleek Deployment — uses the official @fleek-platform/sdk to upload a
// virtual directory to Fleek's IPFS storage and then register that CID as
// a custom IPFS deployment against the site identified by
// `credentials.projectId`. Requires a Personal Access Token + projectId.
async function deployToFleek(
  outputPath: string,
  credentials: PlatformCredentials,
  metadata?: any
): Promise<DecentralizedDeployResult> {
  try {
    if (!credentials.apiKey) {
      throw new Error(
        "Fleek requires a Personal Access Token in `apiKey`",
      );
    }
    if (!credentials.projectId) {
      throw new Error(
        "Fleek requires `projectId` set to the target site id",
      );
    }

    const { FleekSdk, PersonalAccessTokenService } = await import(
      "@fleek-platform/sdk/node"
    );

    const accessTokenService = new PersonalAccessTokenService({
      personalAccessToken: credentials.apiKey,
      projectId: credentials.projectId,
    });
    const fleek = new FleekSdk({ accessTokenService });

    const fileList = await getAllFiles(outputPath);
    const files = await Promise.all(
      fileList.map(async (absPath) => {
        const relativePath = path
          .relative(outputPath, absPath)
          .split(path.sep)
          .join("/");
        const content = await fs.readFile(absPath);
        return { path: relativePath, content };
      }),
    );

    const upload = await fleek.storage().uploadVirtualDirectory({
      files,
      directoryName:
        (metadata?.name as string) || `joycreate-${Date.now()}`,
    });
    const cid = upload.pin.cid;

    const deployment = await fleek.sites().createCustomIpfsDeployment({
      siteId: credentials.projectId,
      cid,
    });

    return {
      success: true,
      platform: "fleek",
      deploymentId: deployment.id,
      cid,
      url: `https://ipfs.io/ipfs/${cid}`,
      gatewayUrls: [
        `https://${cid}.ipfs.flk-ipfs.xyz`,
        `https://ipfs.io/ipfs/${cid}`,
        `https://dweb.link/ipfs/${cid}`,
      ],
      timestamp: Date.now(),
    };
  } catch (error) {
    return {
      success: false,
      platform: "fleek",
      deploymentId: "",
      url: "",
      gatewayUrls: [],
      timestamp: Date.now(),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// Pinata IPFS Deployment
async function deployToPinata(
  outputPath: string,
  credentials: PlatformCredentials,
  metadata?: any
): Promise<DecentralizedDeployResult> {
  const FormData = (await import("form-data")).default;
  const formData = new FormData();

  // Add files to form data
  const files = await getAllFiles(outputPath);
  for (const file of files) {
    const relativePath = path.relative(outputPath, file);
    const content = await fs.readFile(file);
    formData.append("file", content, { filepath: `root/${relativePath}` });
  }

  // Add metadata
  formData.append(
    "pinataMetadata",
    JSON.stringify({
      name: metadata?.name || "JoyCreate Deployment",
      keyvalues: metadata,
    })
  );

  try {
    const response = await fetch(`${API_ENDPOINTS["ipfs-pinata"]}/pinning/pinFileToIPFS`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credentials.apiKey}`,
      },
      body: formData as any,
    });

    if (!response.ok) {
      throw new Error(`Pinata upload failed: ${response.statusText}`);
    }

    const result = await response.json();

    return {
      success: true,
      platform: "ipfs-pinata",
      deploymentId: result.id || result.IpfsHash,
      cid: result.IpfsHash,
      url: `https://gateway.pinata.cloud/ipfs/${result.IpfsHash}`,
      gatewayUrls: [
        `https://gateway.pinata.cloud/ipfs/${result.IpfsHash}`,
        `https://ipfs.io/ipfs/${result.IpfsHash}`,
        `https://dweb.link/ipfs/${result.IpfsHash}`,
        `https://cloudflare-ipfs.com/ipfs/${result.IpfsHash}`,
      ],
      timestamp: Date.now(),
      size: result.PinSize,
    };
  } catch (error) {
    return {
      success: false,
      platform: "ipfs-pinata",
      deploymentId: "",
      url: "",
      gatewayUrls: [],
      timestamp: Date.now(),
      error: String(error),
    };
  }
}

// web3.storage Deployment
//
// The legacy `api.web3.storage/upload` endpoint was deprecated in 2024 in
// favour of the w3up protocol (`@web3-storage/w3up-client`), which requires
// an interactive email-based agent authorization flow that does not fit
// the "paste an API token" credentials model used by the other providers
// in this surface. Rather than silently uploading bytes that web3.storage
// can no longer pin, we return a structured error pointing users to
// Pinata or 4everland (both fully wired below) until a w3up onboarding
// flow is added to the renderer.
async function deployToWeb3Storage(
  _outputPath: string,
  _credentials: PlatformCredentials,
  _metadata?: any
): Promise<DecentralizedDeployResult> {
  return {
    success: false,
    platform: "ipfs-web3storage",
    deploymentId: "",
    url: "",
    gatewayUrls: [],
    timestamp: Date.now(),
    error:
      "web3.storage's legacy upload API is no longer supported. Use Pinata or 4everland for IPFS pinning, or migrate to w3up-client (not yet wired in this build).",
  };
}

// Arweave Deployment — signs and posts each file plus a path manifest
// using arweave-js with a JWK provided in credentials.accessToken (the
// renderer stores the JWK JSON there to keep `apiKey` reserved for simple
// bearer strings on other providers). Each file becomes its own permaweb
// tx; the manifest tx is what the user serves at `https://arweave.net/<id>`.
async function deployToArweave(
  outputPath: string,
  credentials: PlatformCredentials,
  metadata?: any
): Promise<DecentralizedDeployResult> {
  try {
    const jwkRaw = credentials.accessToken || credentials.apiKey;
    if (!jwkRaw) {
      throw new Error(
        "Arweave requires a JWK wallet JSON in `accessToken` (or `apiKey`)",
      );
    }
    let jwk: Record<string, unknown>;
    try {
      jwk = typeof jwkRaw === "string" ? JSON.parse(jwkRaw) : (jwkRaw as Record<string, unknown>);
    } catch {
      throw new Error(
        "Arweave JWK in credentials is not valid JSON — paste the full wallet file contents",
      );
    }

    const ArweaveModule = await import("arweave");
    const Arweave = ArweaveModule.default ?? ArweaveModule;
    // arweave-js's `init` is a static factory on the default export.
    const arweave = (Arweave as any).init({
      host: "arweave.net",
      port: 443,
      protocol: "https",
    });

    const files = await getAllFiles(outputPath);
    const paths: Record<string, { id: string }> = {};
    let totalCostWinston = 0n;

    for (const absPath of files) {
      const relativePath = path
        .relative(outputPath, absPath)
        .split(path.sep)
        .join("/");
      const data = await fs.readFile(absPath);
      const contentType = guessContentType(relativePath);

      const tx = await arweave.createTransaction({ data }, jwk);
      tx.addTag("Content-Type", contentType);
      tx.addTag("App-Name", "JoyCreate");
      tx.addTag("App-Version", (metadata?.version as string) || "1.0.0");
      await arweave.transactions.sign(tx, jwk);
      try {
        totalCostWinston += BigInt(tx.reward || "0");
      } catch {
        /* reward parse best-effort */
      }
      const post = await arweave.transactions.post(tx);
      if (post.status >= 300) {
        throw new Error(
          `Arweave upload failed for ${relativePath}: HTTP ${post.status}`,
        );
      }
      paths[relativePath] = { id: tx.id };
    }

    const manifest = {
      manifest: "arweave/paths",
      version: "0.1.0",
      index: { path: paths["index.html"] ? "index.html" : Object.keys(paths)[0] },
      paths,
    };
    const manifestTx = await arweave.createTransaction(
      { data: JSON.stringify(manifest) },
      jwk,
    );
    manifestTx.addTag(
      "Content-Type",
      "application/x.arweave-manifest+json",
    );
    manifestTx.addTag("App-Name", "JoyCreate");
    manifestTx.addTag("App-Version", (metadata?.version as string) || "1.0.0");
    await arweave.transactions.sign(manifestTx, jwk);
    try {
      totalCostWinston += BigInt(manifestTx.reward || "0");
    } catch {
      /* reward parse best-effort */
    }
    const manifestPost = await arweave.transactions.post(manifestTx);
    if (manifestPost.status >= 300) {
      throw new Error(
        `Arweave manifest upload failed: HTTP ${manifestPost.status}`,
      );
    }

    const arAmount = (Number(totalCostWinston) / 1e12).toFixed(6);
    return {
      success: true,
      platform: "arweave",
      deploymentId: manifestTx.id,
      txId: manifestTx.id,
      url: `https://arweave.net/${manifestTx.id}`,
      gatewayUrls: [
        `https://arweave.net/${manifestTx.id}`,
        `https://arweave.dev/${manifestTx.id}`,
      ],
      timestamp: Date.now(),
      cost: totalCostWinston > 0n ? { amount: arAmount, currency: "AR" } : undefined,
    };
  } catch (error) {
    return {
      success: false,
      platform: "arweave",
      deploymentId: "",
      url: "",
      gatewayUrls: [],
      timestamp: Date.now(),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function guessContentType(relativePath: string): string {
  const ext = path.extname(relativePath).toLowerCase();
  switch (ext) {
    case ".html":
    case ".htm":
      return "text/html";
    case ".css":
      return "text/css";
    case ".js":
    case ".mjs":
      return "application/javascript";
    case ".json":
      return "application/json";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".ico":
      return "image/x-icon";
    case ".woff":
      return "font/woff";
    case ".woff2":
      return "font/woff2";
    case ".ttf":
      return "font/ttf";
    case ".txt":
      return "text/plain";
    case ".wasm":
      return "application/wasm";
    default:
      return "application/octet-stream";
  }
}

// Spheron Deployment
async function deployToSpheron(
  outputPath: string,
  credentials: PlatformCredentials,
  metadata?: any
): Promise<DecentralizedDeployResult> {
  try {
    const FormData = (await import("form-data")).default;
    const formData = new FormData();

    const files = await getAllFiles(outputPath);
    for (const file of files) {
      const relativePath = path.relative(outputPath, file);
      const content = await fs.readFile(file);
      formData.append("files", content, { filepath: relativePath });
    }

    formData.append("name", metadata?.name || "joycreate-deployment");
    formData.append("protocol", "IPFS");

    const response = await fetch(`${API_ENDPOINTS["spheron"]}/v1/deployment`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credentials.apiKey}`,
      },
      body: formData as any,
    });

    const result = await response.json();

    return {
      success: true,
      platform: "spheron",
      deploymentId: result.deploymentId,
      cid: result.ipfsHash,
      url: result.sitePreview,
      gatewayUrls: [
        result.sitePreview,
        `https://ipfs.io/ipfs/${result.ipfsHash}`,
      ],
      timestamp: Date.now(),
    };
  } catch (error) {
    return {
      success: false,
      platform: "spheron",
      deploymentId: "",
      url: "",
      gatewayUrls: [],
      timestamp: Date.now(),
      error: String(error),
    };
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

async function getAllFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await getAllFiles(fullPath)));
    } else {
      files.push(fullPath);
    }
  }

  return files;
}

// ============================================================================
// Main Deploy Function
// ============================================================================

export async function deployToPlatform(
  request: DecentralizedDeployRequest
): Promise<DecentralizedDeployResult> {
  const credentials = await getCredentials(request.platform);
  
  if (!credentials && request.platform !== "arweave" && request.platform !== "skynet") {
    return {
      success: false,
      platform: request.platform,
      deploymentId: "",
      url: "",
      gatewayUrls: [],
      timestamp: Date.now(),
      error: `No credentials configured for ${request.platform}`,
    };
  }

  // Get app path
  const appRecord = await db.select().from(apps).where(eq(apps.id, request.appId)).limit(1);
  if (!appRecord.length) {
    return {
      success: false,
      platform: request.platform,
      deploymentId: "",
      url: "",
      gatewayUrls: [],
      timestamp: Date.now(),
      error: "App not found",
    };
  }

  const appPath = getJoyAppPath(request.appId.toString());
  const outputPath = path.join(appPath, request.outputDir || "dist");

  // Build if needed
  if (request.buildCommand) {
    const buildResult = await buildApp(appPath, {
      buildCommand: request.buildCommand,
      outputDir: request.outputDir || "dist",
      envVars: request.envVars,
    });

    if (!buildResult.success) {
      return {
        success: false,
        platform: request.platform,
        deploymentId: "",
        url: "",
        gatewayUrls: [],
        timestamp: Date.now(),
        error: `Build failed: ${buildResult.logs.join("\n")}`,
      };
    }
  }

  // Deploy to platform
  let result: DecentralizedDeployResult;
  
  switch (request.platform) {
    case "4everland":
      result = await deployTo4Everland(outputPath, credentials!, request.metadata);
      break;
    case "fleek":
      result = await deployToFleek(outputPath, credentials!, request.metadata);
      break;
    case "ipfs-pinata":
      result = await deployToPinata(outputPath, credentials!, request.metadata);
      break;
    case "ipfs-web3storage":
      result = await deployToWeb3Storage(outputPath, credentials!, request.metadata);
      break;
    case "arweave":
      result = await deployToArweave(outputPath, credentials || {} as any, request.metadata);
      break;
    case "spheron":
      result = await deployToSpheron(outputPath, credentials!, request.metadata);
      break;
    default:
      result = {
        success: false,
        platform: request.platform,
        deploymentId: "",
        url: "",
        gatewayUrls: [],
        timestamp: Date.now(),
        error: `Platform ${request.platform} not yet supported`,
      };
  }

  // Save deployment record
  if (result.success) {
    await addDeployment({
      id: result.deploymentId,
      appId: request.appId,
      platform: request.platform,
      status: "live",
      cid: result.cid,
      txId: result.txId,
      url: result.url,
      gatewayUrls: result.gatewayUrls,
      ipnsName: result.ipnsName,
      ensName: request.ensName,
      customDomain: request.customDomain,
      metadata: request.metadata,
      size: result.size,
      cost: result.cost,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  }

  return result;
}

// ============================================================================
// IPC Handler Registration
// ============================================================================

export function registerDecentralizedDeployHandlers(): void {
  // Save platform credentials
  ipcMain.handle(
    "decentralized:save-credentials",
    guarded("decentralized:save-credentials", async (_, platform: DecentralizedPlatform, credentials: PlatformCredentials) => {
      const allCreds = await loadCredentials();
      allCreds[platform] = { ...credentials, platform };
      await saveCredentials(allCreds);
      return { success: true };
    })
  );

  // Get platform credentials (without sensitive data)
  ipcMain.handle(
    "decentralized:get-credentials",
    async (_, platform: DecentralizedPlatform) => {
      const creds = await getCredentials(platform);
      if (!creds) return null;
      // Return without sensitive keys
      return {
        platform: creds.platform,
        projectId: creds.projectId,
        bucketName: creds.bucketName,
        hasApiKey: !!creds.apiKey,
        hasAccessToken: !!creds.accessToken,
      };
    }
  );

  // Remove platform credentials
  ipcMain.handle(
    "decentralized:remove-credentials",
    guarded("decentralized:remove-credentials", async (_, platform: DecentralizedPlatform) => {
      const allCreds = await loadCredentials();
      delete allCreds[platform];
      await saveCredentials(allCreds);
      return { success: true };
    })
  );

  // Deploy to decentralized platform
  ipcMain.handle(
    "decentralized:deploy",
    guarded("decentralized:deploy", async (_, request: DecentralizedDeployRequest) => {
      logger.info(`Deploying app ${request.appId} to ${request.platform}`);
      return deployToPlatform(request);
    })
  );

  // Get deployments for an app
  ipcMain.handle(
    "decentralized:get-deployments",
    async (_, appId?: number) => {
      const deployments = await loadDeployments();
      if (appId) {
        return deployments.filter((d) => d.appId === appId);
      }
      return deployments;
    }
  );

  // Get single deployment
  ipcMain.handle(
    "decentralized:get-deployment",
    async (_, deploymentId: string) => {
      const deployments = await loadDeployments();
      return deployments.find((d) => d.id === deploymentId) || null;
    }
  );

  // Check IPFS pin status
  ipcMain.handle(
    "decentralized:check-pin-status",
    async (_, cid: string, platform: DecentralizedPlatform) => {
      const credentials = await getCredentials(platform);
      if (!credentials) {
        return { status: "unknown", error: "No credentials" };
      }

      try {
        let response;
        switch (platform) {
          case "ipfs-pinata":
            response = await fetch(
              `${API_ENDPOINTS["ipfs-pinata"]}/data/pinList?hashContains=${cid}`,
              {
                headers: { Authorization: `Bearer ${credentials.apiKey}` },
              }
            );
            break;
          default:
            return { status: "unknown", error: "Platform doesn't support pin status" };
        }

        const result = await response.json();
        return {
          cid,
          status: result.rows?.[0]?.status || "unknown",
          providers: [],
        };
      } catch (error) {
        return { status: "error", error: String(error) };
      }
    }
  );

  // Get supported platforms
  ipcMain.handle("decentralized:get-platforms", async () => {
    const { PLATFORM_CONFIGS } = await import("../../types/decentralized_deploy");
    return PLATFORM_CONFIGS;
  });

  logger.info("Decentralized deployment handlers registered");
}
