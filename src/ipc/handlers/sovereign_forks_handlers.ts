/**
 * Sovereign Forks IPC Handlers (Phase 6)
 *
 * Tracks ERC-1155 fork lineage for sovereign Radicle repos. The actual
 * on-chain mint is performed by the existing JoyLicenseToken (DropERC1155)
 * publish flow (see `src/hooks/use_publish_workflow.ts`); these handlers
 * persist the parent/child token relationships into the `radicle_repos`
 * table so the UI can render the fork graph.
 *
 * Columns used (already on `radicle_repos`):
 *   - `baseEditionTokenId`   — token id of the original on-chain edition
 *   - `parentRid`            — RID of the repo this was forked from
 *   - `parentEditionTokenId` — base edition token id of the parent
 */

import { ipcMain } from "electron";
import { eq, isNull } from "drizzle-orm";

import { db } from "@/db";
import { radicleRepos, type RadicleRepoRow } from "@/db/radicle_schema";

// =============================================================================
// PARAM TYPES
// =============================================================================

export interface SetBaseTokenParams {
  rid: string;
  baseEditionTokenId: string;
}

export interface RegisterForkParams {
  /** RID of the new (forked) repo. Must already exist in `radicle_repos`. */
  childRid: string;
  /** RID of the parent repo. Must exist; supplies parentEditionTokenId. */
  parentRid: string;
}

export interface ForkLineageNode {
  rid: string;
  name: string;
  baseEditionTokenId: string | null;
  parentRid: string | null;
  parentEditionTokenId: string | null;
}

// =============================================================================
// HELPERS
// =============================================================================

function repoByRid(rid: string): RadicleRepoRow | undefined {
  return db.select().from(radicleRepos).where(eq(radicleRepos.rid, rid)).get();
}

// =============================================================================
// HANDLERS
// =============================================================================

export function registerSovereignForksHandlers() {
  /**
   * Attach (or update) the on-chain base-edition token id for a repo. Call
   * this after the publish workflow mints the DropERC1155 base edition.
   */
  ipcMain.handle(
    "sovereign-fork:set-base-token",
    async (_, params: SetBaseTokenParams): Promise<RadicleRepoRow> => {
      if (!params?.rid) throw new Error("rid is required");
      if (!params.baseEditionTokenId) throw new Error("baseEditionTokenId is required");
      const row = repoByRid(params.rid);
      if (!row) throw new Error(`Radicle repo not found: ${params.rid}`);
      db.update(radicleRepos)
        .set({
          baseEditionTokenId: params.baseEditionTokenId,
          updatedAt: new Date(),
        })
        .where(eq(radicleRepos.rid, params.rid))
        .run();
      const updated = repoByRid(params.rid);
      if (!updated) throw new Error("Failed to reload repo after update");
      return updated;
    },
  );

  /**
   * Register a fork relationship: marks `childRid` as forked from `parentRid`
   * and copies the parent's `baseEditionTokenId` into `parentEditionTokenId`
   * on the child. Both repos must exist; the parent must have a base token.
   */
  ipcMain.handle(
    "sovereign-fork:register",
    async (_, params: RegisterForkParams): Promise<RadicleRepoRow> => {
      if (!params?.childRid) throw new Error("childRid is required");
      if (!params.parentRid) throw new Error("parentRid is required");
      if (params.childRid === params.parentRid) {
        throw new Error("childRid and parentRid must differ");
      }
      const parent = repoByRid(params.parentRid);
      if (!parent) throw new Error(`Parent repo not found: ${params.parentRid}`);
      if (!parent.baseEditionTokenId) {
        throw new Error(
          `Parent repo ${params.parentRid} has no baseEditionTokenId; mint the base edition first.`,
        );
      }
      const child = repoByRid(params.childRid);
      if (!child) throw new Error(`Child repo not found: ${params.childRid}`);

      db.update(radicleRepos)
        .set({
          parentRid: params.parentRid,
          parentEditionTokenId: parent.baseEditionTokenId,
          updatedAt: new Date(),
        })
        .where(eq(radicleRepos.rid, params.childRid))
        .run();

      const updated = repoByRid(params.childRid);
      if (!updated) throw new Error("Failed to reload child repo after fork registration");
      return updated;
    },
  );

  /** Direct children of `parentRid`. */
  ipcMain.handle(
    "sovereign-fork:list-children",
    async (_, params: { parentRid: string }): Promise<RadicleRepoRow[]> => {
      if (!params?.parentRid) throw new Error("parentRid is required");
      return db
        .select()
        .from(radicleRepos)
        .where(eq(radicleRepos.parentRid, params.parentRid))
        .all();
    },
  );

  /**
   * Walk up the parent chain from `rid` to its root (first repo with no
   * parent). Returns the chain ordered root → ... → rid.
   */
  ipcMain.handle(
    "sovereign-fork:get-lineage",
    async (_, params: { rid: string }): Promise<ForkLineageNode[]> => {
      if (!params?.rid) throw new Error("rid is required");
      const chain: ForkLineageNode[] = [];
      const seen = new Set<string>();
      let cursor: string | null = params.rid;
      while (cursor && !seen.has(cursor)) {
        seen.add(cursor);
        const row = repoByRid(cursor);
        if (!row) break;
        chain.push({
          rid: row.rid,
          name: row.name,
          baseEditionTokenId: row.baseEditionTokenId,
          parentRid: row.parentRid,
          parentEditionTokenId: row.parentEditionTokenId,
        });
        cursor = row.parentRid;
      }
      return chain.reverse();
    },
  );

  /** Repos that have no parent — i.e. the top of every fork tree. */
  ipcMain.handle("sovereign-fork:list-roots", async (): Promise<RadicleRepoRow[]> => {
    return db.select().from(radicleRepos).where(isNull(radicleRepos.parentRid)).all();
  });
}
