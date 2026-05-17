/**
 * API Gateway IPC handlers.
 *
 * Channels registered here MUST also be added to:
 *   - src/preload.ts allowlist
 *   - src/ipc/ipc_client.ts (renderer-side method)
 *
 * Throw-on-error per repo convention.
 */

import { ipcMain } from "electron";
import log from "electron-log";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { apiEndpoints, apiKeys, apiUsageRecords } from "@/db/schema";
import {
  generateApiKey,
  getApiGatewayStatus,
  getEndpointStats,
  startApiGateway,
  stopApiGateway,
} from "@/lib/api_gateway/service";

const logger = log.scope("api_gateway_handlers");

const SLUG_RE = /^[a-z0-9][a-z0-9_-]{1,62}[a-z0-9]$/;

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`${field} is required`);
  return value;
}
function requireNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error(`${field} must be a number`);
  return value;
}
function requireSlug(value: unknown): string {
  const s = requireString(value, "slug");
  if (!SLUG_RE.test(s))
    throw new Error(
      "slug must be lowercase alphanumeric (with - or _), 3-64 chars",
    );
  return s;
}

export function registerApiGatewayHandlers(): void {
  // -------------------------------------------------------------------------
  // Gateway lifecycle
  // -------------------------------------------------------------------------
  ipcMain.handle("api-gateway:status", async () => getApiGatewayStatus());

  ipcMain.handle(
    "api-gateway:start",
    async (_e, raw: { port?: number } = {}) => {
      const port = raw?.port ?? 18791;
      return await startApiGateway(port);
    },
  );

  ipcMain.handle("api-gateway:stop", async () => {
    await stopApiGateway();
    return getApiGatewayStatus();
  });

  // -------------------------------------------------------------------------
  // Endpoint CRUD
  // -------------------------------------------------------------------------
  ipcMain.handle(
    "api-gateway:create-endpoint",
    async (
      _e,
      raw: {
        slug: string;
        name: string;
        description?: string;
        agentId?: number | null;
        configJson?: Record<string, unknown> | null;
        pricePerCallWei?: string;
        pricePerKTokenWei?: string;
        rateLimitPerMin?: number;
      },
    ) => {
      const slug = requireSlug(raw?.slug);
      const name = requireString(raw?.name, "name");
      const existing = await db
        .select({ id: apiEndpoints.id })
        .from(apiEndpoints)
        .where(eq(apiEndpoints.slug, slug))
        .limit(1);
      if (existing.length > 0)
        throw new Error(`slug "${slug}" already exists`);

      const inserted = await db
        .insert(apiEndpoints)
        .values({
          slug,
          name,
          description: raw?.description ?? null,
          agentId: raw?.agentId ?? null,
          configJson: raw?.configJson ?? null,
          pricePerCallWei: raw?.pricePerCallWei ?? "0",
          pricePerKTokenWei: raw?.pricePerKTokenWei ?? "0",
          rateLimitPerMin: raw?.rateLimitPerMin ?? 60,
        })
        .returning();
      logger.info("created endpoint", slug, "id=", inserted[0].id);
      return inserted[0];
    },
  );

  ipcMain.handle("api-gateway:list-endpoints", async () => {
    return await db
      .select()
      .from(apiEndpoints)
      .orderBy(desc(apiEndpoints.createdAt));
  });

  ipcMain.handle(
    "api-gateway:get-endpoint",
    async (_e, raw: { id: number }) => {
      const id = requireNumber(raw?.id, "id");
      const row = (
        await db.select().from(apiEndpoints).where(eq(apiEndpoints.id, id)).limit(1)
      )[0];
      if (!row) throw new Error(`endpoint ${id} not found`);
      const stats = await getEndpointStats(id);
      const keyCount = await db
        .select({ n: sql<number>`count(*)` })
        .from(apiKeys)
        .where(and(eq(apiKeys.endpointId, id), isNull(apiKeys.revokedAt)));
      return { ...row, stats, activeKeyCount: Number(keyCount[0]?.n ?? 0) };
    },
  );

  ipcMain.handle(
    "api-gateway:update-endpoint",
    async (
      _e,
      raw: {
        id: number;
        name?: string;
        description?: string | null;
        enabled?: boolean;
        pricePerCallWei?: string;
        pricePerKTokenWei?: string;
        rateLimitPerMin?: number;
        configJson?: Record<string, unknown> | null;
      },
    ) => {
      const id = requireNumber(raw?.id, "id");
      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if (raw.name !== undefined) patch.name = raw.name;
      if (raw.description !== undefined) patch.description = raw.description;
      if (raw.enabled !== undefined) patch.enabled = raw.enabled;
      if (raw.pricePerCallWei !== undefined)
        patch.pricePerCallWei = raw.pricePerCallWei;
      if (raw.pricePerKTokenWei !== undefined)
        patch.pricePerKTokenWei = raw.pricePerKTokenWei;
      if (raw.rateLimitPerMin !== undefined)
        patch.rateLimitPerMin = raw.rateLimitPerMin;
      if (raw.configJson !== undefined) patch.configJson = raw.configJson;
      const rows = await db
        .update(apiEndpoints)
        .set(patch)
        .where(eq(apiEndpoints.id, id))
        .returning();
      if (rows.length === 0) throw new Error(`endpoint ${id} not found`);
      return rows[0];
    },
  );

  ipcMain.handle(
    "api-gateway:delete-endpoint",
    async (_e, raw: { id: number }) => {
      const id = requireNumber(raw?.id, "id");
      await db.delete(apiUsageRecords).where(eq(apiUsageRecords.endpointId, id));
      await db.delete(apiKeys).where(eq(apiKeys.endpointId, id));
      await db.delete(apiEndpoints).where(eq(apiEndpoints.id, id));
      return { deleted: true };
    },
  );

  // -------------------------------------------------------------------------
  // Keys
  // -------------------------------------------------------------------------
  ipcMain.handle(
    "api-gateway:create-key",
    async (
      _e,
      raw: {
        endpointId: number;
        name: string;
        rateLimitPerMin?: number | null;
        monthlyCallQuota?: number | null;
      },
    ) => {
      const endpointId = requireNumber(raw?.endpointId, "endpointId");
      const name = requireString(raw?.name, "name");
      const exists = await db
        .select({ id: apiEndpoints.id })
        .from(apiEndpoints)
        .where(eq(apiEndpoints.id, endpointId))
        .limit(1);
      if (exists.length === 0) throw new Error(`endpoint ${endpointId} not found`);

      const { secret, prefix, hash } = generateApiKey();
      const inserted = await db
        .insert(apiKeys)
        .values({
          endpointId,
          name,
          keyPrefix: prefix,
          keyHash: hash,
          rateLimitPerMin: raw?.rateLimitPerMin ?? null,
          monthlyCallQuota: raw?.monthlyCallQuota ?? null,
        })
        .returning();
      // Return the secret ONCE — never persisted in plaintext.
      return { key: inserted[0], secret };
    },
  );

  ipcMain.handle(
    "api-gateway:list-keys",
    async (_e, raw: { endpointId: number }) => {
      const endpointId = requireNumber(raw?.endpointId, "endpointId");
      return await db
        .select()
        .from(apiKeys)
        .where(eq(apiKeys.endpointId, endpointId))
        .orderBy(desc(apiKeys.createdAt));
    },
  );

  ipcMain.handle(
    "api-gateway:revoke-key",
    async (_e, raw: { id: number }) => {
      const id = requireNumber(raw?.id, "id");
      const rows = await db
        .update(apiKeys)
        .set({ revokedAt: new Date() })
        .where(eq(apiKeys.id, id))
        .returning();
      if (rows.length === 0) throw new Error(`key ${id} not found`);
      return rows[0];
    },
  );

  // -------------------------------------------------------------------------
  // Usage / stats
  // -------------------------------------------------------------------------
  ipcMain.handle(
    "api-gateway:list-usage",
    async (
      _e,
      raw: { endpointId: number; limit?: number },
    ) => {
      const endpointId = requireNumber(raw?.endpointId, "endpointId");
      const limit = Math.min(Math.max(raw?.limit ?? 50, 1), 500);
      return await db
        .select()
        .from(apiUsageRecords)
        .where(eq(apiUsageRecords.endpointId, endpointId))
        .orderBy(desc(apiUsageRecords.createdAt))
        .limit(limit);
    },
  );
}
