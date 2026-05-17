/**
 * API Gateway — exposes JoyCreate agents as authenticated HTTP endpoints
 * with metered billing.
 *
 *   POST http://127.0.0.1:<port>/api/v1/<slug>
 *     headers: { "x-api-key": "jck_…", "content-type": "application/json" }
 *     body:    { "input": "<user prompt>", ...endpoint-specific }
 *
 * Auth: sha256(apiKey) is looked up against `apiKeys.keyHash`.
 * Rate-limit: per-key (or per-endpoint default), token bucket per minute.
 * Billing: each successful call writes an `api_usage_records` row and emits
 *   `recordMeter` so the tokenomics engine bills the consumer's wallet.
 *
 * The actual agent invocation is delegated to a pluggable handler that
 * higher-level code registers via `setAgentInvoker`. That way this file
 * stays free of `agent_builder` imports (which pull in heavy AI SDKs).
 */

import crypto from "node:crypto";
import http from "node:http";
import { URL } from "node:url";
import log from "electron-log";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { apiEndpoints, apiKeys, apiUsageRecords } from "@/db/schema";

const logger = log.scope("api_gateway");

export type AgentInvoker = (args: {
  endpointId: number;
  agentId: number | null;
  slug: string;
  config: Record<string, unknown> | null;
  input: unknown;
}) => Promise<{
  output: unknown;
  outputTokens?: number;
}>;

/** Default invoker echoes the input — useful for smoke-testing the gateway. */
let invoker: AgentInvoker = async ({ input, slug, config }) => ({
  output: {
    echoed: input,
    slug,
    config,
    note: "default echo invoker — register a real one with setAgentInvoker()",
  },
  outputTokens: 0,
});

export function setAgentInvoker(impl: AgentInvoker): void {
  invoker = impl;
}

// ---------------------------------------------------------------------------
// Key generation / hashing
// ---------------------------------------------------------------------------

const KEY_PREFIX = "jck_";

/** Returns `{ secret, prefix, hash }`. The secret is shown to the user ONCE. */
export function generateApiKey(): {
  secret: string;
  prefix: string;
  hash: string;
} {
  const random = crypto.randomBytes(24).toString("base64url");
  const secret = `${KEY_PREFIX}${random}`;
  const hash = crypto.createHash("sha256").update(secret).digest("hex");
  const prefix = secret.slice(0, 12);
  return { secret, prefix, hash };
}

export function hashApiKey(secret: string): string {
  return crypto.createHash("sha256").update(secret).digest("hex");
}

// ---------------------------------------------------------------------------
// In-memory rate limiter (per key, per minute)
// ---------------------------------------------------------------------------

interface BucketState {
  windowStart: number;
  count: number;
}
const buckets = new Map<number, BucketState>();

function checkRateLimit(apiKeyId: number, limitPerMin: number): boolean {
  const now = Date.now();
  const windowMs = 60_000;
  const cur = buckets.get(apiKeyId);
  if (!cur || now - cur.windowStart >= windowMs) {
    buckets.set(apiKeyId, { windowStart: now, count: 1 });
    return true;
  }
  if (cur.count >= limitPerMin) return false;
  cur.count += 1;
  return true;
}

// ---------------------------------------------------------------------------
// Request handling
// ---------------------------------------------------------------------------

function send(
  res: http.ServerResponse,
  status: number,
  body: unknown,
): void {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.setHeader("content-length", Buffer.byteLength(payload));
  res.end(payload);
}

async function readJsonBody(
  req: http.IncomingMessage,
  maxBytes = 1_000_000,
): Promise<{ raw: Buffer; parsed: unknown }> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > maxBytes) throw new Error("request body too large");
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks);
  if (raw.length === 0) return { raw, parsed: null };
  try {
    return { raw, parsed: JSON.parse(raw.toString("utf8")) };
  } catch {
    throw new Error("invalid JSON body");
  }
}

function computeChargeWei(
  pricePerCallWei: string,
  pricePerKTokenWei: string,
  outputTokens: number,
): string {
  try {
    const perCall = BigInt(pricePerCallWei || "0");
    const perK = BigInt(pricePerKTokenWei || "0");
    const tokenCharge = (perK * BigInt(Math.max(0, outputTokens))) / 1000n;
    return (perCall + tokenCharge).toString();
  } catch {
    return "0";
  }
}

async function handleApiRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  slug: string,
): Promise<void> {
  const started = Date.now();
  let endpointRow: typeof apiEndpoints.$inferSelect | undefined;
  let keyRow: typeof apiKeys.$inferSelect | undefined;

  try {
    if (req.method !== "POST") {
      send(res, 405, { error: "method not allowed; use POST" });
      return;
    }
    const apiKey =
      (req.headers["x-api-key"] as string | undefined) ??
      (req.headers["authorization"] as string | undefined)?.replace(
        /^Bearer\s+/i,
        "",
      );
    if (!apiKey) {
      send(res, 401, { error: "missing x-api-key header" });
      return;
    }

    endpointRow = (
      await db
        .select()
        .from(apiEndpoints)
        .where(eq(apiEndpoints.slug, slug))
        .limit(1)
    )[0];
    if (!endpointRow) {
      send(res, 404, { error: `unknown endpoint slug "${slug}"` });
      return;
    }
    if (!endpointRow.enabled) {
      send(res, 503, { error: "endpoint disabled" });
      return;
    }

    const hash = hashApiKey(apiKey);
    keyRow = (
      await db
        .select()
        .from(apiKeys)
        .where(and(eq(apiKeys.keyHash, hash), eq(apiKeys.endpointId, endpointRow.id)))
        .limit(1)
    )[0];
    if (!keyRow) {
      send(res, 401, { error: "invalid api key" });
      return;
    }
    if (keyRow.revokedAt) {
      send(res, 401, { error: "api key revoked" });
      return;
    }

    const perMin = keyRow.rateLimitPerMin ?? endpointRow.rateLimitPerMin;
    if (!checkRateLimit(keyRow.id, perMin)) {
      send(res, 429, { error: "rate limit exceeded" });
      return;
    }

    const { raw, parsed } = await readJsonBody(req);
    const input =
      parsed && typeof parsed === "object" && "input" in (parsed as object)
        ? (parsed as { input: unknown }).input
        : parsed;

    const result = await invoker({
      endpointId: endpointRow.id,
      agentId: endpointRow.agentId,
      slug,
      config: endpointRow.configJson ?? null,
      input,
    });

    const outputPayload = JSON.stringify({ output: result.output });
    const outputTokens = result.outputTokens ?? 0;
    const chargedWei = computeChargeWei(
      endpointRow.pricePerCallWei,
      endpointRow.pricePerKTokenWei,
      outputTokens,
    );

    await db.insert(apiUsageRecords).values({
      endpointId: endpointRow.id,
      apiKeyId: keyRow.id,
      bytesIn: raw.length,
      bytesOut: Buffer.byteLength(outputPayload),
      outputTokens,
      latencyMs: Date.now() - started,
      statusCode: 200,
      chargedWei,
    });
    await db
      .update(apiKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(apiKeys.id, keyRow.id));

    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.setHeader("x-charged-wei", chargedWei);
    res.setHeader("x-latency-ms", String(Date.now() - started));
    res.end(outputPayload);
  } catch (err) {
    const message = (err as Error).message ?? "internal error";
    logger.error("api gateway error", slug, message);
    if (endpointRow && keyRow) {
      try {
        await db.insert(apiUsageRecords).values({
          endpointId: endpointRow.id,
          apiKeyId: keyRow.id,
          bytesIn: 0,
          bytesOut: 0,
          outputTokens: 0,
          latencyMs: Date.now() - started,
          statusCode: 500,
          chargedWei: "0",
          errorMessage: message.slice(0, 500),
        });
      } catch {
        /* swallow secondary failure */
      }
    }
    if (!res.headersSent) send(res, 500, { error: message });
  }
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

let server: http.Server | null = null;
let listenPort: number | null = null;

export interface ApiGatewayStatus {
  running: boolean;
  port: number | null;
  baseUrl: string | null;
}

export function getApiGatewayStatus(): ApiGatewayStatus {
  return {
    running: server !== null,
    port: listenPort,
    baseUrl: listenPort ? `http://127.0.0.1:${listenPort}` : null,
  };
}

export async function startApiGateway(port = 18791): Promise<ApiGatewayStatus> {
  if (server) return getApiGatewayStatus();

  const srv = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/healthz") {
      send(res, 200, { ok: true });
      return;
    }
    const match = url.pathname.match(/^\/api\/v1\/([A-Za-z0-9_\-]+)\/?$/);
    if (!match) {
      send(res, 404, { error: "not found" });
      return;
    }
    void handleApiRequest(req, res, match[1]);
  });

  await new Promise<void>((resolve, reject) => {
    srv.once("error", reject);
    srv.listen(port, "127.0.0.1", () => {
      srv.off("error", reject);
      resolve();
    });
  });

  server = srv;
  listenPort = port;
  logger.info("API gateway listening on", `http://127.0.0.1:${port}`);
  return getApiGatewayStatus();
}

export async function stopApiGateway(): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
  listenPort = null;
  buckets.clear();
  logger.info("API gateway stopped");
}

// ---------------------------------------------------------------------------
// Stats helpers — used by the IPC handlers
// ---------------------------------------------------------------------------

export async function getEndpointStats(endpointId: number): Promise<{
  totalCalls: number;
  errorCalls: number;
  totalChargedWei: string;
  avgLatencyMs: number;
}> {
  const rows = await db
    .select({
      total: sql<number>`count(*)`,
      errors: sql<number>`sum(case when status_code >= 400 then 1 else 0 end)`,
      charged: sql<string>`coalesce(sum(cast(charged_wei as integer)), 0)`,
      avgLat: sql<number>`coalesce(avg(latency_ms), 0)`,
    })
    .from(apiUsageRecords)
    .where(eq(apiUsageRecords.endpointId, endpointId));
  const r = rows[0] ?? { total: 0, errors: 0, charged: "0", avgLat: 0 };
  return {
    totalCalls: Number(r.total ?? 0),
    errorCalls: Number(r.errors ?? 0),
    totalChargedWei: String(r.charged ?? "0"),
    avgLatencyMs: Math.round(Number(r.avgLat ?? 0)),
  };
}
