/**
 * Persistence layer for `blueprint_runs`. All mutations go through here so
 * the in-memory `BlueprintOrchestrator` and external observers (UI, IPC
 * subscribers) see consistent state.
 */

import { eq, inArray, desc } from "drizzle-orm";
import { getDb } from "@/db";
import {
  blueprintRuns,
  type BlueprintNodeRunState,
  type BlueprintRunStatus,
} from "@/db/schema";

export interface BlueprintRunRecord {
  id: string;
  blueprintId: string;
  blueprintVersion: string;
  manifestHash: string;
  agentDid: string;
  status: BlueprintRunStatus;
  currentNodeId: string | null;
  nodeState: Record<string, BlueprintNodeRunState>;
  input: Record<string, unknown> | null;
  output: unknown;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
}

export interface CreateRunArgs {
  id: string;
  blueprintId: string;
  blueprintVersion: string;
  manifestHash: string;
  agentDid: string;
  input: Record<string, unknown> | null;
}

export async function createRun(args: CreateRunArgs): Promise<BlueprintRunRecord> {
  const db = getDb();
  const [row] = await db
    .insert(blueprintRuns)
    .values({
      id: args.id,
      blueprintId: args.blueprintId,
      blueprintVersion: args.blueprintVersion,
      manifestHash: args.manifestHash,
      agentDid: args.agentDid,
      status: "pending",
      nodeStateJson: {},
      inputJson: args.input,
    })
    .returning();
  return rowToRecord(row);
}

export async function getRun(id: string): Promise<BlueprintRunRecord | null> {
  const db = getDb();
  const row = await db.query.blueprintRuns.findFirst({
    where: eq(blueprintRuns.id, id),
  });
  return row ? rowToRecord(row) : null;
}

export async function listRuns(limit = 100): Promise<BlueprintRunRecord[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(blueprintRuns)
    .orderBy(desc(blueprintRuns.updatedAt))
    .limit(limit);
  return rows.map(rowToRecord);
}

/** All runs left dangling by an app crash; foundation for `resumeAllPending()`. */
export async function listResumableRuns(): Promise<BlueprintRunRecord[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(blueprintRuns)
    .where(inArray(blueprintRuns.status, ["pending", "running", "paused"]));
  return rows.map(rowToRecord);
}

export async function updateRunStatus(
  id: string,
  status: BlueprintRunStatus,
  extra: { currentNodeId?: string | null; output?: unknown; error?: string | null } = {},
): Promise<void> {
  const db = getDb();
  const updates: Record<string, unknown> = {
    status,
    updatedAt: new Date(),
  };
  if (extra.currentNodeId !== undefined) updates.currentNodeId = extra.currentNodeId;
  if (extra.output !== undefined) updates.outputJson = extra.output;
  if (extra.error !== undefined) updates.error = extra.error;
  if (status === "succeeded" || status === "failed" || status === "aborted") {
    updates.completedAt = new Date();
  }
  await db.update(blueprintRuns).set(updates).where(eq(blueprintRuns.id, id));
}

export async function updateNodeState(
  id: string,
  nodeId: string,
  state: BlueprintNodeRunState,
): Promise<void> {
  const db = getDb();
  const row = await db.query.blueprintRuns.findFirst({
    where: eq(blueprintRuns.id, id),
  });
  if (!row) throw new Error(`Blueprint run ${id} not found`);
  const merged = { ...(row.nodeStateJson ?? {}), [nodeId]: state };
  await db
    .update(blueprintRuns)
    .set({ nodeStateJson: merged, currentNodeId: nodeId, updatedAt: new Date() })
    .where(eq(blueprintRuns.id, id));
}

function rowToRecord(row: typeof blueprintRuns.$inferSelect): BlueprintRunRecord {
  return {
    id: row.id,
    blueprintId: row.blueprintId,
    blueprintVersion: row.blueprintVersion,
    manifestHash: row.manifestHash,
    agentDid: row.agentDid,
    status: row.status,
    currentNodeId: row.currentNodeId,
    nodeState: row.nodeStateJson ?? {},
    input: row.inputJson,
    output: row.outputJson,
    error: row.error,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    completedAt: row.completedAt,
  };
}
