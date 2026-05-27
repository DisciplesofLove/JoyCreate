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

export const VERCEL_GITHUB_APP_INSTALL_URL = "https://github.com/apps/vercel";

/**
 * Structured deploy errors. The renderer parses `Error.message` as JSON
 * (looking for the `joy: true` marker) and renders an actionable CTA.
 * IPC strips custom Error fields, so we ship metadata in the message itself.
 */
export interface JoyDeployErrorMeta {
  joy: true;
  code:
    | "vercel_token_missing"
    | "vercel_token_invalid"
    | "vercel_github_app_missing"
    | "vercel_project_name_taken"
    | "vercel_forbidden"
    | "vercel_not_found"
    | "github_not_connected"
    | "vercel_unknown";
  message: string;
  installUrl?: string;
  repo?: string;
  details?: string;
}

function joyDeployError(meta: Omit<JoyDeployErrorMeta, "joy">): Error {
  const payload: JoyDeployErrorMeta = { joy: true, ...meta };
  return new Error(JSON.stringify(payload));
}

export { joyDeployError };

/**
 * Best-effort parse of a raw Vercel SDK / fetch error into a structured
 * Joy deploy error. Falls back to `vercel_unknown` when no pattern matches.
 */
export function mapVercelError(
  err: unknown,
  context: { repo?: string } = {},
): Error {
  const raw =
    err instanceof Error ? err.message : typeof err === "string" ? err : String(err);

  // GitHub App not installed (the primary issue we're fixing)
  if (
    raw.includes("install the GitHub integration") ||
    raw.includes("Install GitHub App") ||
    raw.includes("github.com/apps/vercel")
  ) {
    return joyDeployError({
      code: "vercel_github_app_missing",
      message:
        "The Vercel GitHub App isn't installed on this repository yet. Install it and grant access to the repo, then retry.",
      installUrl: VERCEL_GITHUB_APP_INSTALL_URL,
      repo: context.repo,
      details: raw,
    });
  }

  if (raw.includes("name_already_in_use") || raw.includes("already exists")) {
    return joyDeployError({
      code: "vercel_project_name_taken",
      message:
        "A Vercel project with this name already exists. Pick a different name or connect to the existing project.",
      details: raw,
    });
  }

  if (raw.includes("Status 401") || raw.includes("unauthorized") || raw.includes("forbidden")) {
    return joyDeployError({
      code: "vercel_token_invalid",
      message:
        "Your Vercel access token was rejected. Re-connect Vercel with a fresh token.",
      details: raw,
    });
  }

  if (raw.includes("Status 403")) {
    return joyDeployError({
      code: "vercel_forbidden",
      message:
        "Vercel rejected the request (403). Check that your token has access to this team and project.",
      details: raw,
    });
  }

  if (raw.includes("Status 404") || raw.includes("not_found")) {
    return joyDeployError({
      code: "vercel_not_found",
      message: "Vercel resource not found. The project or team may have been deleted.",
      details: raw,
    });
  }

  return joyDeployError({
    code: "vercel_unknown",
    message: raw || "Vercel request failed.",
    details: raw,
  });
}

/**
 * Check whether the Vercel GitHub integration is installed on the user's
 * account/team. Returns the install URL plus the list of org slugs the
 * integration is currently authorized for.
 *
 * Used as a pre-flight before `createProject({ gitRepository })` so we can
 * surface an actionable "Install Vercel GitHub App" CTA in the renderer
 * instead of bubbling a generic 400 from the SDK.
 */
async function fetchVercelGithubAppStatus(token: string): Promise<{
  installed: boolean;
  installUrl: string;
  configurations: Array<{ id?: string; ownerType?: string; slug?: string }>;
}> {
  const url = `${VERCEL_API_BASE}/v1/integrations/configuration?slug=github`;
  try {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });
    if (!response.ok) {
      // 404 means no configuration; treat as not installed rather than throwing.
      if (response.status === 404) {
        return {
          installed: false,
          installUrl: VERCEL_GITHUB_APP_INSTALL_URL,
          configurations: [],
        };
      }
      const body = await response.text();
      throw new Error(
        `Vercel integration check failed: ${response.status} ${response.statusText} - ${body}`,
      );
    }
    const data = (await response.json()) as
      | { configurations?: Array<{ id?: string; ownerType?: string; slug?: string }> }
      | Array<{ id?: string; ownerType?: string; slug?: string }>;
    const configurations = Array.isArray(data)
      ? data
      : Array.isArray(data?.configurations)
        ? data.configurations
        : [];
    return {
      installed: configurations.length > 0,
      installUrl: VERCEL_GITHUB_APP_INSTALL_URL,
      configurations,
    };
  } catch (err) {
    logger.warn("fetchVercelGithubAppStatus failed:", err);
    // Don't block the deploy on a flaky check; report unknown and let the
    // downstream create-project error mapping handle it.
    return {
      installed: true,
      installUrl: VERCEL_GITHUB_APP_INSTALL_URL,
      configurations: [],
    };
  }
}

export async function checkVercelGithubAppForRepo(
  token: string,
  repo: { org: string; repo: string },
): Promise<{ installed: boolean; installUrl: string; configuredOrgs: string[] }> {
  const status = await fetchVercelGithubAppStatus(token);
  const configuredOrgs = status.configurations
    .map((c) => c.slug)
    .filter((s): s is string => typeof s === "string" && s.length > 0);
  // If the integration is installed at all, trust the create-project call
  // to surface a repo-specific error (the configuration API doesn't always
  // return per-repo grants for personal accounts).
  return {
    installed: status.installed,
    installUrl: status.installUrl,
    configuredOrgs,
  };
}

/**
 * List every Vercel team the token can see. Used by `findTeamForGithubRepo`
 * to discover where the Vercel GitHub App is installed when the token's
 * default scope is a different team than the one that owns the repo —
 * which otherwise causes `createProject` to reject with a misleading
 * "Install GitHub App" error even when the app IS installed.
 */
async function listVercelTeams(
  token: string,
): Promise<Array<{ id: string; slug?: string }>> {
  const teams: Array<{ id: string; slug?: string }> = [];
  let next: string | null = null;
  // Vercel paginates teams; cap iterations defensively.
  for (let i = 0; i < 10; i++) {
    const url = new URL(`${VERCEL_API_BASE}/v2/teams`);
    url.searchParams.set("limit", "100");
    if (next) url.searchParams.set("until", next);
    const res = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });
    if (!res.ok) break;
    const data = (await res.json()) as {
      teams?: Array<{ id: string; slug?: string }>;
      pagination?: { next?: string | null };
    };
    if (Array.isArray(data.teams)) teams.push(...data.teams);
    next = data.pagination?.next ?? null;
    if (!next) break;
  }
  return teams;
}

/**
 * Find the Vercel team where the GitHub integration is configured for the
 * given GitHub org. Returns `null` if no team in the token's scope has the
 * integration for that org (typical when the user hasn't installed the
 * Vercel GitHub App yet). Returns `{ teamId: null }` when the personal
 * account (no team) has the integration installed for that org.
 */
export async function findTeamForGithubRepo(
  token: string,
  repo: { org: string; repo: string },
): Promise<{ teamId: string | null; teamSlug?: string } | null> {
  const orgLower = repo.org.toLowerCase();

  // 1. Check the token's default scope (personal account or default team).
  const personal = await fetchVercelGithubAppStatus(token);
  if (
    personal.installed &&
    personal.configurations.some(
      (c) => (c.slug ?? "").toLowerCase() === orgLower,
    )
  ) {
    return { teamId: null };
  }

  // 2. Walk every team the token can see and probe each with `teamId=`.
  const teams = await listVercelTeams(token);
  for (const team of teams) {
    try {
      const url = new URL(
        `${VERCEL_API_BASE}/v1/integrations/configuration`,
      );
      url.searchParams.set("slug", "github");
      url.searchParams.set("teamId", team.id);
      const res = await fetch(url.toString(), {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      });
      if (!res.ok) continue;
      const data = (await res.json()) as
        | {
            configurations?: Array<{ slug?: string }>;
          }
        | Array<{ slug?: string }>;
      const configs = Array.isArray(data)
        ? data
        : Array.isArray(data?.configurations)
          ? data.configurations
          : [];
      if (
        configs.some((c) => (c.slug ?? "").toLowerCase() === orgLower)
      ) {
        return { teamId: team.id, teamSlug: team.slug };
      }
    } catch (err) {
      logger.warn(
        `findTeamForGithubRepo: probing team ${team.id} failed:`,
        err,
      );
    }
  }

  // 3. Fall back: if the integration is installed *somewhere* but we couldn't
  // match the org (e.g. private API quirks), default to the first team that
  // has any github configuration; that's usually correct for single-team
  // accounts. Return null when nothing is installed at all.
  for (const team of teams) {
    try {
      const url = new URL(
        `${VERCEL_API_BASE}/v1/integrations/configuration`,
      );
      url.searchParams.set("slug", "github");
      url.searchParams.set("teamId", team.id);
      const res = await fetch(url.toString(), {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      });
      if (!res.ok) continue;
      const data = (await res.json()) as
        | { configurations?: Array<unknown> }
        | Array<unknown>;
      const configs = Array.isArray(data)
        ? data
        : Array.isArray(data?.configurations)
          ? data.configurations
          : [];
      if (configs.length > 0) {
        return { teamId: team.id, teamSlug: team.slug };
      }
    } catch {
      /* ignore */
    }
  }

  if (personal.installed) return { teamId: null };
  return null;
}

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

export async function getVercelUser(
  token: string,
): Promise<{ username?: string; email?: string } | null> {
  try {
    const vercel = createVercelClient(token);
    const res: any = await vercel.user.getAuthUser();
    const user = res?.user ?? res;
    if (!user) return null;
    return {
      username: user.username || user.name,
      email: user.email,
    };
  } catch (error) {
    logger.warn("getVercelUser failed:", error);
    return null;
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

  // Hoisted so the catch block can include repo context.
  let app: typeof apps.$inferSelect | undefined;
  try {
    logger.info(`Creating Vercel project: ${sanitizedName} for app ${appId}`);

    // Get app details to determine the framework
    app = await db.query.apps.findFirst({ where: eq(apps.id, appId) });
    if (!app) {
      throw new Error("App not found.");
    }

    // Check if app has GitHub repository configured
    if (!app.githubOrg || !app.githubRepo) {
      throw joyDeployError({
        code: "github_not_connected",
        message:
          "This app isn't connected to a GitHub repository yet. Connect GitHub first, then deploy to Vercel.",
      });
    }

    // Pre-flight: locate the Vercel team that has the GitHub integration
    // installed for this repo's owning org. The integration is scoped per
    // team; when the user's token defaults to a different team than the one
    // where they installed the app, `createProject` rejects with a
    // misleading "Install GitHub App" error. Passing the correct `teamId`
    // makes Vercel use that team's integration grant.
    let scopedTeamId: string | null = null;
    try {
      const match = await findTeamForGithubRepo(accessToken, {
        org: app.githubOrg,
        repo: app.githubRepo,
      });
      if (!match) {
        logger.warn(
          `No Vercel team in this token's scope has the GitHub App installed for ${app.githubOrg}; proceeding optimistically.`,
        );
      } else {
        scopedTeamId = match.teamId;
        logger.info(
          `Using Vercel team ${match.teamSlug ?? match.teamId ?? "<personal>"} for createProject (GitHub App grant for ${app.githubOrg}).`,
        );
      }
    } catch (preflightErr) {
      logger.warn(
        "Vercel GitHub App team-discovery failed; proceeding to createProject without explicit teamId:",
        preflightErr,
      );
    }

    // Detect the framework from the app's directory
    const detectedFramework = await detectFramework(getJoyAppPath(app.path));

    logger.info(
      `Detected framework: ${detectedFramework || "none detected"} for app at ${app.path}`,
    );

    const vercel = createVercelClient(accessToken);

    const projectData = await vercel.projects.createProject({
      ...(scopedTeamId ? { teamId: scopedTeamId } : {}),
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

    // Prefer the team we already scoped createProject to so every follow-up
    // call hits the same Vercel team. Only fall back to the default team
    // lookup when the project was created in the personal (no-team) scope.
    const teamId = scopedTeamId ?? (await getDefaultTeamId(accessToken));

    const projectDomains = await vercel.projects.getProjectDomains({
      idOrName: projectData.id,
      ...(scopedTeamId ? { teamId: scopedTeamId } : {}),
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
        ...(scopedTeamId ? { teamId: scopedTeamId } : {}),
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
    // If we already threw a structured Joy error above, rethrow as-is so the
    // renderer can parse the code/installUrl.
    if (
      err instanceof Error &&
      typeof err.message === "string" &&
      err.message.startsWith("{\"joy\":true")
    ) {
      throw err;
    }
    const repo =
      app && app.githubOrg && app.githubRepo
        ? `${app.githubOrg}/${app.githubRepo}`
        : undefined;
    throw mapVercelError(err, { repo });
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

// --- Vercel Pre-flight Handlers (read-only) ---
async function handleCheckGithubApp(): Promise<{
  installed: boolean;
  installUrl: string;
  configuredOrgs: string[];
}> {
  const settings = readSettings();
  const accessToken = settings.vercelAccessToken?.value;
  if (!accessToken) {
    throw joyDeployError({
      code: "vercel_token_missing",
      message: "Connect Vercel first.",
    });
  }
  const status = await fetchVercelGithubAppStatus(accessToken);
  const configuredOrgs = status.configurations
    .map((c) => c.slug)
    .filter((s): s is string => typeof s === "string" && s.length > 0);
  return {
    installed: status.installed,
    installUrl: status.installUrl,
    configuredOrgs,
  };
}

async function handleValidateToken(): Promise<{
  valid: boolean;
  user?: { username?: string; email?: string };
}> {
  const settings = readSettings();
  const accessToken = settings.vercelAccessToken?.value;
  if (!accessToken) {
    return { valid: false };
  }
  const user = await getVercelUser(accessToken);
  if (!user) return { valid: false };
  return { valid: true, user };
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
  handle("vercel:check-github-app", handleCheckGithubApp);
  handle("vercel:validate-token", handleValidateToken);
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
