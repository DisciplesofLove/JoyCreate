/**
 * Neon agent helpers — run SQL and read project metadata for the local agent's
 * Neon-aware tools (execute_sql on Neon, get_neon_project_info).
 *
 * Mirrors the Supabase management helpers but targets a Neon project/branch via
 * the Neon management API (for connection URIs + metadata) and the serverless
 * driver (for actually executing SQL).
 */

import { neon } from "@neondatabase/serverless";
import log from "electron-log";
import { getNeonClient } from "./neon_management_client";

const logger = log.scope("neon_sql");

const DEFAULT_DATABASE = "neondb";
const DEFAULT_ROLE = "neondb_owner";

/** Resolve a connection URI for a Neon project/branch. */
async function getNeonConnectionUri({
  projectId,
  branchId,
}: {
  projectId: string;
  branchId?: string | null;
}): Promise<string> {
  const client = await getNeonClient();
  const params: {
    projectId: string;
    database_name: string;
    role_name: string;
    branch_id?: string;
  } = {
    projectId,
    database_name: DEFAULT_DATABASE,
    role_name: DEFAULT_ROLE,
  };
  if (branchId) {
    params.branch_id = branchId;
  }
  const connectionUri = await client.getConnectionUri(params);
  return connectionUri.data.uri;
}

/**
 * Execute SQL against a Neon project/branch. Returns the result rows (may be
 * empty for statements that don't return rows).
 */
export async function executeNeonSql({
  projectId,
  branchId,
  query,
}: {
  projectId: string;
  branchId?: string | null;
  query: string;
}): Promise<Record<string, unknown>[]> {
  const uri = await getNeonConnectionUri({ projectId, branchId });
  const sql = neon(uri);
  try {
    const rows = (await sql.query(query)) as Record<string, unknown>[];
    return rows ?? [];
  } catch (error) {
    logger.error("Error executing Neon SQL:", error);
    throw new Error(
      `Failed to execute SQL on Neon: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export interface NeonProjectSummary {
  projectId: string;
  name: string;
  regionId: string;
  createdAt?: string;
  branches: {
    id: string;
    name: string;
    isDefault: boolean;
    isProtected: boolean;
  }[];
  databases: string[];
}

/** Read project metadata + branches + databases for the given Neon project. */
export async function getNeonProjectSummary(
  projectId: string,
  branchId?: string | null,
): Promise<NeonProjectSummary> {
  const client = await getNeonClient();

  const project = await client.getProject(projectId);
  const branchesResp = await client.listProjectBranches({ projectId });

  let databases: string[] = [];
  const resolvedBranchId =
    branchId ??
    branchesResp.data.branches.find((b) => b.default)?.id ??
    branchesResp.data.branches[0]?.id;
  if (resolvedBranchId) {
    try {
      const dbResp = await client.listProjectBranchDatabases(
        projectId,
        resolvedBranchId,
      );
      databases = dbResp.data.databases.map((d) => d.name);
    } catch (error) {
      logger.debug(`Could not list Neon databases: ${error}`);
    }
  }

  return {
    projectId,
    name: project.data.project.name,
    regionId: project.data.project.region_id,
    createdAt: project.data.project.created_at,
    branches: branchesResp.data.branches.map((b) => ({
      id: b.id,
      name: b.name,
      isDefault: !!b.default,
      isProtected: !!b.protected,
    })),
    databases,
  };
}
