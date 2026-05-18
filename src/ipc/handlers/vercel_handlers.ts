import { ipcMain, IpcMainInvokeEvent } from "electron";
import { Vercel } from "@vercel/sdk";
import { writeSettings, readSettings } from "../../main/settings";
import * as schema from "../../db/schema";
import { db } from "../../db";
import { apps } from "../../db/schema";
import { eq } from "drizzle-orm";
import log from "electron-log";
import { IS_TEST_BUILD } from "../utils/test_utils";
import * as fs from "fs";
import * as path from "path";
import { CreateProjectFramework } from "@vercel/sdk/models/createprojectop.js";
import { getJoyAppPath } from "@/paths/paths";
import {
  CreateVercelProjectParams,
  IsVercelProjectAvailableParams,
  SaveVercelAccessTokenParams,
  VercelDeployment,
  VercelProject,
} from "../ipc_types";
import { ConnectToExistingVercelProjectParams } from "../ipc_types";
import { GetVercelDeploymentsParams } from "../ipc_types";
import { DisconnectVercelProjectParams } from "../ipc_types";
import { createLoggedHandler } from "./safe_handle";

const logger = log.scope("vercel_handlers");
const handle = createLoggedHandler(logger);

// Use test server URLs when in test mode
const TEST_SERVER_BASE = "http://localhost:3500";

const VERCEL_API_BASE = IS_TEST_BUILD
  ? `${TEST_SERVER_BASE}/vercel/api`
  : "https://api.vercel.com";

// --- Helper Functions ---

function createVercelClient(token: string): Vercel {
  return new Vercel({
    bearerToken: token,
    ...(IS_TEST_BUILD && { serverURL: VERCEL_API_BASE }),
  });
}

/**
 * Sanitize a string into a valid Vercel project name.
 * Vercel rules: lowercase letters, digits, '.', '_', '-'; max 100 chars;
 * cannot contain the sequence '---'; must not start/end with separator.
 * See https://vercel.com/docs/projects/overview#project-name
 */
export function sanitizeVercelProjectName(input: string): string {
  let name = (input ?? "").toLowerCase().trim();
  // Replace whitespace and any disallowed chars with '-'.
  name = name.replace(/[^a-z0-9._-]+/g, "-");
  // Collapse runs of '-' so we never produce the forbidden '---' sequence.
  name = name.replace(/-{2,}/g, "-");
  // Strip leading/trailing separators.
  name = name.replace(/^[._-]+|[._-]+$/g, "");
  // Cap at 100 chars (Vercel limit).
  if (name.length > 100) name = name.slice(0, 100).replace(/[._-]+$/g, "");
  // Final fallback if everything got stripped.
  if (!name) name = `app-${Date.now().toString(36)}`;
  return name;
}

interface VercelProjectResponse {
  id: string;
  name: string;
  framework?: string | null;
  targets?: {
    production?: {
      url?: string;
    };
  };
}

interface GetVercelProjectsResponse {
  projects: VercelProjectResponse[];
}

/**
 * Fetch Vercel projects via HTTP request (bypasses the broken SDK).
 * Mimics the SDK's `vercel.projects.getProjects` API.
 */
async function getVercelProjects(
  token: string,
  options?: { search?: string },
): Promise<GetVercelProjectsResponse> {
  const url = new URL(`${VERCEL_API_BASE}/v9/projects`);
  if (options?.search) {
    url.searchParams.set("search", options.search);
  }

  const response = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Failed to fetch Vercel projects: ${response.status} ${response.statusText} - ${errorText}`,
    );
  }

  const data = await response.json();
  return {
    projects: data.projects || [],
  };
}

async function validateVercelToken(token: string): Promise<boolean> {
  try {
    const vercel = createVercelClient(token);
    await vercel.user.getAuthUser();
    return true;
  } catch (error) {
    logger.error("Error validating Vercel token:", error);
    return false;
  }
}

async function getDefaultTeamId(token: string): Promise<string> {
  try {
    const response = await fetch(`${VERCEL_API_BASE}/v2/teams?limit=1`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      throw new Error(
        `Failed to fetch teams: ${response.status} ${response.statusText}`,
      );
    }

    const data = await response.json();

    // Use the first team (typically the personal account or default team)
    if (data.teams && data.teams.length > 0) {
      return data.teams[0].id;
    }

    throw new Error("No teams found for this user");
  } catch (error) {
    logger.error("Error getting default team ID:", error);
    throw new Error("Failed to get team information");
  }
}

async function detectFramework(
  appPath: string,
): Promise<CreateProjectFramework | undefined> {
  try {
    // Check for specific config files first
    const configFiles: Array<{
      file: string;
      framework: CreateProjectFramework;
    }> = [
      { file: "next.config.js", framework: "nextjs" },
      { file: "next.config.mjs", framework: "nextjs" },
      { file: "next.config.ts", framework: "nextjs" },
      { file: "vite.config.js", framework: "vite" },
      { file: "vite.config.ts", framework: "vite" },
      { file: "vite.config.mjs", framework: "vite" },
      { file: "nuxt.config.js", framework: "nuxtjs" },
      { file: "nuxt.config.ts", framework: "nuxtjs" },
      { file: "astro.config.js", framework: "astro" },
      { file: "astro.config.mjs", framework: "astro" },
      { file: "astro.config.ts", framework: "astro" },
      { file: "svelte.config.js", framework: "svelte" },
    ];

    for (const { file, framework } of configFiles) {
      if (fs.existsSync(path.join(appPath, file))) {
        return framework;
      }
    }

    // Check package.json for dependencies
    const packageJsonPath = path.join(appPath, "package.json");
    if (fs.existsSync(packageJsonPath)) {
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
      const dependencies = {
        ...packageJson.dependencies,
        ...packageJson.devDependencies,
      };

      // Check for framework dependencies in order of preference
      if (dependencies.next) return "nextjs";
      if (dependencies.vite) return "vite";
      if (dependencies.nuxt) return "nuxtjs";
      if (dependencies.astro) return "astro";
      if (dependencies.svelte) return "svelte";
      if (dependencies["@angular/core"]) return "angular";
      if (dependencies.vue) return "vue";
      if (dependencies["react-scripts"]) return "create-react-app";
      if (dependencies.gatsby) return "gatsby";
      if (dependencies.remix) return "remix";
    }

    // Default fallback
    return undefined;
  } catch (error) {
    logger.error("Error detecting framework:", error);
    return undefined;
  }
}

// --- IPC Handlers ---

async function handleSaveVercelToken(
  event: IpcMainInvokeEvent,
  { token }: SaveVercelAccessTokenParams,
): Promise<void> {
  logger.debug("Saving Vercel access token");

  if (!token || token.trim() === "") {
    throw new Error("Access token is required.");
  }

  try {
    // Validate the token by making a test API call
    const isValid = await validateVercelToken(token.trim());
    if (!isValid) {
      throw new Error(
        "Invalid access token. Please check your token and try again.",
      );
    }

    writeSettings({
      vercelAccessToken: {
        value: token.trim(),
      },
    });

    logger.log("Successfully saved Vercel access token.");
  } catch (error: any) {
    logger.error("Error saving Vercel token:", error);
    throw new Error(`Failed to save access token: ${error.message}`);
  }
}

// --- Vercel List Projects Handler ---
async function handleListVercelProjects(): Promise<VercelProject[]> {
  try {
    const settings = readSettings();
    const accessToken = settings.vercelAccessToken?.value;
    if (!accessToken) {
      throw new Error("Not authenticated with Vercel.");
    }

    const response = await getVercelProjects(accessToken);

    if (!response.projects) {
      throw new Error("Failed to retrieve projects from Vercel.");
    }

    return response.projects.map((project) => ({
      id: project.id,
      name: project.name,
      framework: project.framework || null,
    }));
  } catch (err: any) {
    logger.error("[Vercel Handler] Failed to list projects:", err);
    throw new Error(err.message || "Failed to list Vercel projects.");
  }
}

// --- Vercel Project Availability Handler ---
async function handleIsProjectAvailable(
  event: IpcMainInvokeEvent,
  { name }: IsVercelProjectAvailableParams,
): Promise<{ available: boolean; error?: string }> {
  const sanitized = sanitizeVercelProjectName(name);
  try {
    const settings = readSettings();
    const accessToken = settings.vercelAccessToken?.value;
    if (!accessToken) {
      return { available: false, error: "Not authenticated with Vercel." };
    }

    // Check if project name is available by searching for projects with that name
    const response = await getVercelProjects(accessToken, { search: sanitized });

    if (!response.projects) {
      return {
        available: false,
        error: "Failed to check project availability.",
      };
    }

    const projectExists = response.projects.some(
      (project) => project.name === sanitized,
    );

    return {
      available: !projectExists,
      error: projectExists ? "Project name is not available." : undefined,
    };
  } catch (err: any) {
    return { available: false, error: err.message || "Unknown error" };
  }
}

// --- Vercel Create Project Handler ---
async function handleCreateProject(
  event: IpcMainInvokeEvent,
  { name, appId }: CreateVercelProjectParams,
): Promise<void> {
  const settings = readSettings();
  const accessToken = settings.vercelAccessToken?.value;
  if (!accessToken) {
    throw new Error("Not authenticated with Vercel.");
  }

  const sanitizedName = sanitizeVercelProjectName(name);
  if (sanitizedName !== name) {
    logger.info(
      `Sanitized Vercel project name '${name}' → '${sanitizedName}'`,
    );
  }

  try {
    logger.info(`Creating Vercel project: ${sanitizedName} for app ${appId}`);

    // Get app details to determine the framework
    const app = await db.query.apps.findFirst({ where: eq(apps.id, appId) });
    if (!app) {
      throw new Error("App not found.");
    }

    // Check if app has GitHub repository configured
    if (!app.githubOrg || !app.githubRepo) {
      throw new Error(
        "App must be connected to a GitHub repository before creating a Vercel project.",
      );
    }

    // Detect the framework from the app's directory
    const detectedFramework = await detectFramework(getJoyAppPath(app.path));

    logger.info(
      `Detected framework: ${detectedFramework || "none detected"} for app at ${app.path}`,
    );

    const vercel = createVercelClient(accessToken);

    const projectData = await vercel.projects.createProject({
      requestBody: {
        name: sanitizedName,
        gitRepository: {
          type: "github",
          repo: `${app.githubOrg}/${app.githubRepo}`,
        },
        framework: detectedFramework,
      },
    });
    if (!projectData.id) {
      throw new Error("Failed to create project: No project ID returned.");
    }

    // Get the default team ID
    const teamId = await getDefaultTeamId(accessToken);

    const projectDomains = await vercel.projects.getProjectDomains({
      idOrName: projectData.id,
    });
    const projectUrl = "https://" + projectDomains.domains[0].name;

    // Store project info in the app's DB row
    await updateAppVercelProject({
      appId,
      projectId: projectData.id,
      projectName: projectData.name,
      teamId: teamId,
      deploymentUrl: projectUrl,
    });

    logger.info(
      `Successfully created Vercel project: ${projectData.id} with GitHub repo: ${app.githubOrg}/${app.githubRepo}`,
    );

    // Trigger the first deployment
    logger.info(`Triggering first deployment for project: ${projectData.id}`);
    try {
      // Create deployment via Vercel SDK using the project settings we just created
      const deploymentData = await vercel.deployments.createDeployment({
        requestBody: {
          name: projectData.name,
          project: projectData.id,
          target: "production",
          gitSource: {
            type: "github",
            org: app.githubOrg,
            repo: app.githubRepo,
            ref: app.githubBranch || "main",
          },
        },
      });

      if (deploymentData.url) {
        logger.info(`First deployment successful: ${deploymentData.url}`);
      } else {
        logger.warn("First deployment failed: No deployment URL returned");
      }
    } catch (deployError: any) {
      logger.warn(`First deployment failed with error: ${deployError.message}`);
      // Don't throw here - project creation was successful, deployment failure is non-critical
    }
  } catch (err: any) {
    logger.error("[Vercel Handler] Failed to create project:", err);
    // Vercel returns a 400 "bad_request" with an actionable message + link
    // when the Vercel GitHub App is not installed on the target repo. The
    // raw SDK error is something like:
    //   "API error occurred: Status 400 Content-Type ... Body: {\"error\":{\"code\":\"bad_request\",\"message\":\"To link a GitHub repository, you need to install the GitHub integration first. ...\",\"action\":\"Install GitHub App\",\"link\":\"https://github.com/apps/vercel\",\"repo\":\"...\"}}"
    // Detect that pattern and rethrow a friendly message so the UI can
    // render an actionable "Install Vercel GitHub App" CTA.
    const raw = err?.message ?? String(err);
    if (
      typeof raw === "string" &&
      (raw.includes("install the GitHub integration") ||
        raw.includes("Install GitHub App") ||
        raw.includes("github.com/apps/vercel"))
    ) {
      throw new Error(
        "Vercel needs the Vercel GitHub App installed on this repository before it can link it. " +
          "Install it here and grant access to the repo, then click Create Project again: " +
          "https://github.com/apps/vercel",
      );
    }
    throw new Error(raw || "Failed to create Vercel project.");
  }
}

// --- Vercel Connect to Existing Project Handler ---
async function handleConnectToExistingProject(
  event: IpcMainInvokeEvent,
  { projectId, appId }: ConnectToExistingVercelProjectParams,
): Promise<void> {
  try {
    const settings = readSettings();
    const accessToken = settings.vercelAccessToken?.value;
    if (!accessToken) {
      throw new Error("Not authenticated with Vercel.");
    }

    logger.info(
      `Connecting to existing Vercel project: ${projectId} for app ${appId}`,
    );

    // Verify the project exists and get its details
    const response = await getVercelProjects(accessToken);
    const projectData = response.projects?.find(
      (p) => p.id === projectId || p.name === projectId,
    );

    if (!projectData) {
      throw new Error("Project not found. Please check the project ID.");
    }

    // Get the default team ID
    const teamId = await getDefaultTeamId(accessToken);

    // Store project info in the app's DB row
    await updateAppVercelProject({
      appId,
      projectId: projectData.id,
      projectName: projectData.name,
      teamId: teamId,
      deploymentUrl: projectData.targets?.production?.url
        ? `https://${projectData.targets.production.url}`
        : null,
    });

    logger.info(`Successfully connected to Vercel project: ${projectData.id}`);
  } catch (err: any) {
    logger.error(
      "[Vercel Handler] Failed to connect to existing project:",
      err,
    );
    throw new Error(err.message || "Failed to connect to existing project.");
  }
}

// --- Vercel Get Deployments Handler ---
async function handleGetVercelDeployments(
  event: IpcMainInvokeEvent,
  { appId }: GetVercelDeploymentsParams,
): Promise<VercelDeployment[]> {
  try {
    const settings = readSettings();
    const accessToken = settings.vercelAccessToken?.value;
    if (!accessToken) {
      throw new Error("Not authenticated with Vercel.");
    }

    const app = await db.query.apps.findFirst({ where: eq(apps.id, appId) });
    if (!app || !app.vercelProjectId) {
      throw new Error("App is not linked to a Vercel project.");
    }

    logger.info(
      `Getting deployments for Vercel project: ${app.vercelProjectId} for app ${appId}`,
    );

    const vercel = createVercelClient(accessToken);

    // Get deployments for the project
    const deploymentsResponse = await vercel.deployments.getDeployments({
      projectId: app.vercelProjectId,
      limit: 3, // Get last 3 deployments
    });

    if (!deploymentsResponse.deployments) {
      throw new Error("Failed to retrieve deployments from Vercel.");
    }

    // Map deployments to our interface format
    return deploymentsResponse.deployments.map((deployment) => ({
      uid: deployment.uid,
      url: deployment.url,
      state: deployment.state || "unknown",
      createdAt: deployment.createdAt || 0,
      target: deployment.target || "production",
      readyState: deployment.readyState || "unknown",
    }));
  } catch (err: any) {
    logger.error("[Vercel Handler] Failed to get deployments:", err);
    throw new Error(err.message || "Failed to get Vercel deployments.");
  }
}

async function handleDisconnectVercelProject(
  event: IpcMainInvokeEvent,
  { appId }: DisconnectVercelProjectParams,
): Promise<void> {
  logger.log(`Disconnecting Vercel project for appId: ${appId}`);

  const app = await db.query.apps.findFirst({
    where: eq(apps.id, appId),
  });

  if (!app) {
    throw new Error("App not found");
  }

  // Update app in database to remove Vercel project info
  await db
    .update(apps)
    .set({
      vercelProjectId: null,
      vercelProjectName: null,
      vercelTeamId: null,
      vercelDeploymentUrl: null,
    })
    .where(eq(apps.id, appId));
}

// --- Registration ---
export function registerVercelHandlers() {
  // DO NOT LOG this handler because tokens are sensitive
  ipcMain.handle("vercel:save-token", handleSaveVercelToken);

  // Logged handlers
  handle("vercel:list-projects", handleListVercelProjects);
  handle("vercel:is-project-available", handleIsProjectAvailable);
  handle("vercel:create-project", handleCreateProject);
  handle("vercel:connect-existing-project", handleConnectToExistingProject);
  handle("vercel:get-deployments", handleGetVercelDeployments);
  handle("vercel:disconnect", handleDisconnectVercelProject);
}

export async function updateAppVercelProject({
  appId,
  projectId,
  projectName,
  teamId,
  deploymentUrl,
}: {
  appId: number;
  projectId: string;
  projectName: string;
  teamId: string;
  deploymentUrl?: string | null;
}): Promise<void> {
  await db
    .update(schema.apps)
    .set({
      vercelProjectId: projectId,
      vercelProjectName: projectName,
      vercelTeamId: teamId,
      vercelDeploymentUrl: deploymentUrl,
    })
    .where(eq(schema.apps.id, appId));
}
