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
import { HyperLogStore } from "@/lib/hyper/hyper_log_store";

// ---------------------------------------------------------------------------
// Hypercore replication (Phase 1) — every state mutation of a blueprint run
// is fire-and-forget appended to a per-run hypercore log so peers can verify
// the run's history end-to-end. Failures are swallowed so the local SQLite
// write path is never blocked by the swarm being offline.
// ---------------------------------------------------------------------------

interface BlueprintRunEvent {
  kind:
    | "created"
    | "status-changed"
    | "node-state-changed";
  runId: string;
  ts: number;
  payload: Record<string, unknown>;
}

async function emitRunEvent(runId: string, event: BlueprintRunEvent): Promise<void> {
  const store = new HyperLogStore<BlueprintRunEvent>("blueprint-runs", runId);
  const result = await store.tryAppend(event);
  if (!result) return;
  try {
    await getDb()
      .update(blueprintRuns)
      .set({ hyperSeq: result.seq, hyperHash: result.hashHex })
      .where(eq(blueprintRuns.id, runId));
  } catch {
    // best-effort — losing the seq stamp doesn't break the run
  }
}

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
  yamlText: string | null;
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
  yamlText: string;
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
      yamlText: args.yamlText,
    })
    .returning();
  const record = rowToRecord(row);
  void emitRunEvent(record.id, {
    kind: "created",
    runId: record.id,
    ts: Date.now(),
    payload: {
      blueprintId: record.blueprintId,
      blueprintVersion: record.blueprintVersion,
      manifestHash: record.manifestHash,
      agentDid: record.agentDid,
      input: record.input,
    },
  });
  return record;
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
  void emitRunEvent(id, {
    kind: "status-changed",
    runId: id,
    ts: Date.now(),
    payload: {
      status,
      currentNodeId: extra.currentNodeId ?? null,
      output: extra.output ?? null,
      error: extra.error ?? null,
    },
  });
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
  const merged = { ...row.nodeStateJson, [nodeId]: state };
  await db
    .update(blueprintRuns)
    .set({ nodeStateJson: merged, currentNodeId: nodeId, updatedAt: new Date() })
    .where(eq(blueprintRuns.id, id));
  void emitRunEvent(id, {
    kind: "node-state-changed",
    runId: id,
    ts: Date.now(),
    payload: { nodeId, state },
  });
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
    yamlText: row.yamlText ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    completedAt: row.completedAt,
  };
}
