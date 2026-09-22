/**
 * Local audit-log read access.
 *
 * Why this exists alongside `jcn:admin:auditLog`
 * ----------------------------------------------
 * `jcn_audit_log` already had three real writers (the auth gateway, the job
 * executor and the key manager) and exactly one reader — `jcn:admin:auditLog`,
 * which calls `requirePermission(auth, "audit:read")` and therefore needs a JWT
 * or a wallet signature. That gate is correct for what it guards: JCN is the
 * *networked* service, where several principals share one node and one of them
 * must not read another's history.
 *
 * The desktop UI is not that. It has no token, never mints one, and runs as the
 * person who owns the machine, the profile and the database file — someone who
 * can read `sqlite.db` with any SQLite client regardless of what this handler
 * decides. Gating a local read behind a credential the local UI cannot obtain
 * bought no security and cost the entire feature: the Audit Log page rendered
 * eight invented rows for a year while a real trail sat in the table underneath
 * it.
 *
 * So: local reads are allowed, remote reads keep their gate. The two paths stay
 * separate on purpose — `jcn:admin:auditLog` is untouched, so nothing this
 * handler does widens access for a networked caller. These channels are also
 * read-only. Nothing here can write, amend or delete an audit row, because an
 * audit log that its subject can edit is not one.
 */

import { and, desc, eq, gte, like, lte, or, type SQL } from "drizzle-orm";
import log from "electron-log";

import { createLoggedHandler } from "./safe_handle";
import { getDb } from "@/db";
import { jcnAuditLog } from "@/db/schema";

const logger = log.scope("audit_handlers");
const handle = createLoggedHandler(logger);

export interface AuditQueryParams {
  search?: string;
  actorType?: "user" | "system" | "admin";
  targetType?: "publish" | "job" | "bundle" | "license" | "key" | "config";
  startTime?: number;
  endTime?: number;
  limit?: number;
  offset?: number;
}

function buildWhere(params: AuditQueryParams): SQL | undefined {
  const conditions: SQL[] = [];

  if (params.actorType) {
    conditions.push(eq(jcnAuditLog.actorType, params.actorType));
  }
  if (params.targetType) {
    conditions.push(eq(jcnAuditLog.targetType, params.targetType));
  }
  if (params.startTime) {
    conditions.push(gte(jcnAuditLog.timestamp, new Date(params.startTime)));
  }
  if (params.endTime) {
    conditions.push(lte(jcnAuditLog.timestamp, new Date(params.endTime)));
  }
  if (params.search?.trim()) {
    // Free-text search across the fields a person would actually search by.
    // Note the original `jcn:admin:auditLog` chained `.where()` calls, which in
    // Drizzle *replaces* the clause rather than ANDing it — so filtering by two
    // things there silently applied only the last one. Conditions are collected
    // and combined once here instead.
    const q = `%${params.search.trim()}%`;
    const anyOf = or(
      like(jcnAuditLog.action, q),
      like(jcnAuditLog.actorId, q),
      like(jcnAuditLog.targetId, q),
    );
    if (anyOf) conditions.push(anyOf);
  }

  if (conditions.length === 0) return undefined;
  return conditions.length === 1 ? conditions[0] : and(...conditions);
}

export function registerAuditHandlers(): void {
  handle("audit:query", async (_, params: AuditQueryParams = {}) => {
    const limit = Math.min(Math.max(params.limit ?? 200, 1), 2000);
    const rows = await getDb()
      .select()
      .from(jcnAuditLog)
      .where(buildWhere(params))
      .orderBy(desc(jcnAuditLog.timestamp))
      .limit(limit)
      .offset(Math.max(params.offset ?? 0, 0));

    return rows.map((r) => ({
      ...r,
      timestamp:
        r.timestamp instanceof Date
          ? r.timestamp.toISOString()
          : new Date(r.timestamp as unknown as number).toISOString(),
    }));
  });

  handle("audit:stats", async () => {
    const rows = await getDb()
      .select({
        actorType: jcnAuditLog.actorType,
        targetType: jcnAuditLog.targetType,
        timestamp: jcnAuditLog.timestamp,
      })
      .from(jcnAuditLog);

    const byActor: Record<string, number> = {};
    const byTarget: Record<string, number> = {};
    let newest: Date | null = null;
    let oldest: Date | null = null;

    for (const r of rows) {
      byActor[r.actorType] = (byActor[r.actorType] ?? 0) + 1;
      byTarget[r.targetType] = (byTarget[r.targetType] ?? 0) + 1;
      const t = r.timestamp instanceof Date ? r.timestamp : new Date(r.timestamp as unknown as number);
      if (!newest || t > newest) newest = t;
      if (!oldest || t < oldest) oldest = t;
    }

    return {
      total: rows.length,
      byActor,
      byTarget,
      newest: newest?.toISOString() ?? null,
      oldest: oldest?.toISOString() ?? null,
    };
  });

  /**
   * Export matching rows as CSV or JSON text.
   *
   * The text comes back to the renderer, which saves it — rather than this
   * handler writing a file — so the user picks the destination through their
   * own browser download, and the handler keeps no filesystem powers it does
   * not need.
   */
  handle(
    "audit:export",
    async (_, params: AuditQueryParams & { format?: "csv" | "json" } = {}) => {
      const format = params.format ?? "csv";
      const rows = await getDb()
        .select()
        .from(jcnAuditLog)
        .where(buildWhere(params))
        .orderBy(desc(jcnAuditLog.timestamp))
        .limit(Math.min(Math.max(params.limit ?? 10000, 1), 100000));

      const normalised = rows.map((r) => ({
        ...r,
        timestamp:
          r.timestamp instanceof Date
            ? r.timestamp.toISOString()
            : new Date(r.timestamp as unknown as number).toISOString(),
      }));

      if (format === "json") {
        return {
          format,
          rowCount: normalised.length,
          content: JSON.stringify(normalised, null, 2),
        };
      }

      const columns = [
        "timestamp",
        "action",
        "actorType",
        "actorId",
        "actorWallet",
        "targetType",
        "targetId",
        "requestId",
        "traceId",
      ] as const;

      // Quote every field and double any embedded quotes. An action or id
      // containing a comma would otherwise shift every later column, which is
      // the kind of corruption nobody notices until the export is evidence.
      const escape = (v: unknown): string => {
        if (v === null || v === undefined) return '""';
        return `"${String(v).replace(/"/g, '""')}"`;
      };

      const lines = [
        columns.join(","),
        ...normalised.map((r) =>
          columns.map((c) => escape((r as Record<string, unknown>)[c])).join(","),
        ),
      ];

      return { format, rowCount: normalised.length, content: lines.join("\n") };
    },
  );

  logger.info("Audit handlers registered (3 channels, local read-only)");
}
