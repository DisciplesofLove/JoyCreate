/**
 * Agent Marketplace IPC Handlers
 *
 * Publishing, unpublishing, and updating agents on JoyMarketplace.
 *
 * As of feat/onchain-publish-orchestrator: publishing routes through the
 * on-chain `PublishOrchestrator` (pin -> mint -> list) instead of the
 * Supabase `/v1/assets/publish` endpoint (which doesn't exist for joy_xxx
 * keys). The orchestrator NEVER throws \u2014 every failure is reported via
 * `PublishOutcome.errors / blockedAt` so the renderer can surface
 * actionable errors.
 */

import { ipcMain, app } from "electron";
import { db } from "@/db";
import { agents, agentTools, agentKnowledgeBases } from "@/db/schema";
import { eq } from "drizzle-orm";
import log from "electron-log";
import * as fs from "fs-extra";
import * as path from "path";
import { guarded } from "@/ipc/utils/guarded_handle";
import type { UnifiedPublishPayload, PublishResult } from "@/types/publish_types";
import { JOYMARKETPLACE_API } from "@/config/joymarketplace";
import {
  publishAndForget,
  type PublishOutcome,
} from "@/lib/joymarketplace/publish_orchestrator";

const logger = log.scope("agent_marketplace");

const MARKETPLACE_API_URL = JOYMARKETPLACE_API.baseUrl;

/**
 * Publish a single agent to JoyMarketplace via the on-chain orchestrator.
 * Exported as a callable so the Telegram / Discord bots can invoke it
 * without going through ipcMain.
 *
 * Returns the orchestrator's PublishOutcome augmented with the agent record
 * id (so callers can correlate). Never throws.
 */
export async function publishAgentToMarketplace(payload: {
  agentId: number;
  /** Optional pricing / category passthrough. */
  priceUsdc?: number;
  royaltyBps?: number;
  category?: string;
  dryRun?: boolean;
}): Promise<PublishOutcome & { agentId: number }> {
  const { agentId } = payload;
  logger.info(`Publishing agent ${agentId} to marketplace (dryRun=${Boolean(payload.dryRun)})`);

  const agent = await db.query.agents.findFirst({ where: eq(agents.id, agentId) });
  if (!agent) {
    return {
      ok: false,
      dryRun: Boolean(payload.dryRun),
      errors: [`Agent not found: ${agentId}`],
      agentId,
    };
  }

  const tools = await db
    .select()
    .from(agentTools)
    .where(eq(agentTools.agentId, agentId));

  let kbs: Array<{ name: string; type: string; config: unknown }> = [];
  try {
    const rows = await db
      .select()
      .from(agentKnowledgeBases)
      .where(eq(agentKnowledgeBases.agentId, agentId));
    kbs = rows.map((kb) => ({
      name: kb.name,
      type: kb.sourceType,
      config: kb.sourceConfigJson,
    }));
  } catch {
    // table may not exist yet
  }

  const agentBundle = {
    name: agent.name,
    type: agent.type,
    systemPrompt: agent.systemPrompt,
    modelId: agent.modelId,
    temperature: agent.temperature,
    maxTokens: agent.maxTokens,
    configJson: agent.configJson,
    version: agent.version,
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      implementationCode: t.implementationCode,
      requiresApproval: t.requiresApproval,
    })),
    knowledgeBases: kbs,
  };

  const outcome = await publishAndForget({
    assetType: "agent",
    name: agent.name,
    description: agent.description ?? undefined,
    contentBuffer: Buffer.from(JSON.stringify(agentBundle, null, 2)),
    contentMimeType: "application/json",
    metadata: {
      agentType: agent.type,
      modelId: agent.modelId,
      toolCount: tools.length,
      knowledgeBaseCount: kbs.length,
      hasCustomUI: Boolean((agent.configJson as { uiComponents?: unknown[] } | null)?.uiComponents?.length),
      category: payload.category ?? "ai-agent",
    },
    priceUsdc: payload.priceUsdc ?? 0,
    royaltyBps: payload.royaltyBps ?? 250,
    dryRun: payload.dryRun,
  });

  // Update local agent record per outcome
  try {
    if (outcome.dryRun && outcome.ok) {
      await db
        .update(agents)
        .set({
          dryRunAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(agents.id, agentId));
    } else if (outcome.ok) {
      await db
        .update(agents)
        .set({
          // AgentStatus = draft|testing|deployed|archived; "deployed" is the
          // closest match for a published-to-marketplace agent. The richer
          // publish state lives in `publishStatus`.
          status: "deployed" as const,
          publishStatus: "published" as const,
          marketplaceId: outcome.tokenId ?? undefined,
          publishedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(agents.id, agentId));
    }
  } catch (err) {
    logger.warn(`agent row update failed: ${(err as Error).message}`);
  }

  if (outcome.ok) {
    logger.info(
      `Agent ${agentId} ${outcome.dryRun ? "dry-run" : "published"} as token ${outcome.tokenId}`,
    );
  } else {
    logger.warn(`Agent ${agentId} publish blocked at ${outcome.blockedAt}: ${outcome.errors?.join("; ")}`);
  }

  return { ...outcome, agentId };
}

// ---------------------------------------------------------------------------
// Legacy credential helper (kept for unpublish + update-listing only).
// ---------------------------------------------------------------------------

async function getCredentials(): Promise<{ apiKey: string; publisherId: string }> {
  const credPath = path.join(
    app.getPath("userData"),
    "marketplace-credentials.json",
  );
  if (!(await fs.pathExists(credPath))) {
    throw new Error(
      "Not authenticated with JoyMarketplace. Please connect your account first.",
    );
  }
  const data = await fs.readJson(credPath);
  if (!data?.apiKey) throw new Error("Invalid marketplace credentials");
  return data;
}

// ---------------------------------------------------------------------------
// IPC registration
// ---------------------------------------------------------------------------

export function registerAgentMarketplaceHandlers(): void {
  ipcMain.handle(
    "agent:publish-to-marketplace",
    guarded("agent:publish-to-marketplace", async (
      _e,
      payload: UnifiedPublishPayload & { dryRun?: boolean },
    ): Promise<PublishResult & { onchain: PublishOutcome }> => {
      const outcome = await publishAgentToMarketplace({
        agentId: Number(payload.sourceId),
        // payload.price is in CENTS (legacy convention); orchestrator wants USD dollars
        priceUsdc:
          typeof payload.price === "number" ? payload.price / 100 : undefined,
        royaltyBps:
          typeof (payload as { royaltyBps?: number }).royaltyBps === "number"
            ? (payload as { royaltyBps?: number }).royaltyBps
            : undefined,
        category: payload.category,
        dryRun: payload.dryRun,
      });

      // Map orchestrator outcome to the renderer-facing PublishResult shape.
      // We carry the full outcome under `.onchain` so the UI can surface
      // dry-run gas estimates / blockedAt reasons.
      return {
        assetId: outcome.tokenId ?? `pending-${Date.now()}`,
        assetUrl:
          outcome.marketplaceUrl ??
          (outcome.tokenId
            ? `https://joymarketplace.io/asset/${outcome.tokenId}`
            : ""),
        status: outcome.ok ? (outcome.dryRun ? "draft" : "published") : "draft",
        onchain: outcome,
      } as PublishResult & { onchain: PublishOutcome };
    }),
  );

  // Unpublish an agent (legacy Supabase path; unchanged).
  ipcMain.handle("agent:unpublish", guarded("agent:unpublish", async (_e, agentId: number) => {
    const agent = await db.query.agents.findFirst({ where: eq(agents.id, agentId) });
    if (!agent) throw new Error(`Agent not found: ${agentId}`);

    const marketplaceId = agent.marketplaceId ?? undefined;
    if (marketplaceId) {
      try {
        const { apiKey, publisherId } = await getCredentials();
        await fetch(
          `${MARKETPLACE_API_URL}/v1/assets/${encodeURIComponent(marketplaceId)}/archive`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "X-Publisher-ID": publisherId,
            },
          },
        );
      } catch (err) {
        logger.warn(`legacy unpublish failed (non-fatal): ${(err as Error).message}`);
      }
    }

    await db
      .update(agents)
      .set({
        status: "draft" as const,
        publishStatus: "local" as const,
        marketplaceId: null,
        updatedAt: new Date(),
      })
      .where(eq(agents.id, agentId));

    logger.info(`Agent ${agentId} unpublished`);
    return { ok: true };
  }));

  // Update a published agent listing (legacy Supabase path; unchanged).
  ipcMain.handle(
    "agent:update-listing",
    guarded("agent:update-listing", async (
      _e,
      params: { agentId: number; updates: Partial<UnifiedPublishPayload> },
    ) => {
      const agent = await db.query.agents.findFirst({ where: eq(agents.id, params.agentId) });
      if (!agent?.marketplaceId) {
        throw new Error("Agent has no marketplace listing");
      }

      const { apiKey, publisherId } = await getCredentials();
      const response = await fetch(
        `${MARKETPLACE_API_URL}/v1/assets/${encodeURIComponent(agent.marketplaceId)}`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
            "X-Publisher-ID": publisherId,
          },
          body: JSON.stringify(params.updates),
        },
      );
      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Update failed: ${response.status} \u2014 ${body}`);
      }
      return response.json();
    }),
  );

  // Install an agent FROM the marketplace into the local DB. Buyer-side
  // counterpart to `agent:publish-to-marketplace`. Fetches the published
  // bundle (JSON pinned to IPFS), validates its shape, and creates new
  // local rows in agents / agent_tools / agent_knowledge_bases.
  //
  // The new agent is inserted with publishStatus="local" so the buyer can
  // edit/republish under their own listing without overwriting the
  // upstream one.
  ipcMain.handle(
    "agent:install-from-marketplace",
    guarded("agent:install-from-marketplace", async (
      _e,
      input: { contentUrl?: string; tokenId?: string; assetId?: string },
    ): Promise<{ agentId: number; name: string; toolCount: number; kbCount: number }> => {
      const bundle = await fetchAgentBundle(input);

      const insertedAgent = await db
        .insert(agents)
        .values({
          name: bundle.name || "Installed Agent",
          description: typeof bundle.description === "string" ? bundle.description : null,
          type: typeof bundle.type === "string" ? (bundle.type as never) : "chatbot",
          status: "draft" as const,
          systemPrompt: typeof bundle.systemPrompt === "string" ? bundle.systemPrompt : null,
          modelId: typeof bundle.modelId === "string" ? bundle.modelId : null,
          temperature:
            typeof bundle.temperature === "number" ? bundle.temperature : null,
          maxTokens: typeof bundle.maxTokens === "number" ? bundle.maxTokens : null,
          configJson: (bundle.configJson ?? null) as never,
          version: typeof bundle.version === "string" ? bundle.version : "1.0.0",
          publishStatus: "local" as const,
        })
        .returning({ id: agents.id, name: agents.name });

      const agentId = insertedAgent[0].id;

      let toolCount = 0;
      if (Array.isArray(bundle.tools)) {
        for (const t of bundle.tools) {
          if (!t || typeof t.name !== "string") continue;
          await db.insert(agentTools).values({
            agentId,
            name: t.name,
            description: typeof t.description === "string" ? t.description : "",
            inputSchema: (t.inputSchema ?? null) as never,
            implementationCode:
              typeof t.implementationCode === "string" ? t.implementationCode : null,
            // Default-true: marketplace-installed tools require approval until
            // the user explicitly trusts them.
            requiresApproval: true,
          });
          toolCount++;
        }
      }

      let kbCount = 0;
      if (Array.isArray(bundle.knowledgeBases)) {
        for (const kb of bundle.knowledgeBases) {
          if (!kb || typeof kb.name !== "string") continue;
          await db.insert(agentKnowledgeBases).values({
            agentId,
            name: kb.name,
            sourceType: typeof kb.type === "string" ? kb.type : "files",
            sourceConfigJson: (kb.config ?? null) as never,
          });
          kbCount++;
        }
      }

      logger.info(
        `Installed agent #${agentId} "${insertedAgent[0].name}" from marketplace (tools=${toolCount}, kbs=${kbCount})`,
      );
      return {
        agentId,
        name: insertedAgent[0].name,
        toolCount,
        kbCount,
      };
    }),
  );
}

// ---------------------------------------------------------------------------
// Bundle fetching helpers
// ---------------------------------------------------------------------------

interface InstallableAgentBundle {
  name?: string;
  description?: string;
  type?: string;
  systemPrompt?: string;
  modelId?: string;
  temperature?: number;
  maxTokens?: number;
  configJson?: unknown;
  version?: string;
  tools?: Array<{
    name?: string;
    description?: string;
    inputSchema?: unknown;
    implementationCode?: string;
  }>;
  knowledgeBases?: Array<{ name?: string; type?: string; config?: unknown }>;
}

/**
 * Resolve a marketplace asset reference to its agent bundle JSON.
 *
 * The renderer is expected to first look up an asset (e.g. via
 * `joybridge:get-asset`) and pass us the resulting `contentUrl`.
 *
 * `tokenId` / `assetId` are accepted but currently informational — callers
 * should resolve them to a `contentUrl` first. (Adding an in-process
 * resolver here would create a circular dependency with joybridge_handlers.)
 */
async function fetchAgentBundle(input: {
  contentUrl?: string;
  tokenId?: string;
  assetId?: string;
}): Promise<InstallableAgentBundle> {
  let url = input.contentUrl;

  if (!url && (input.tokenId || input.assetId)) {
    const { resolveAssetContentUrl } = await import("./joybridge_handlers");
    url = await resolveAssetContentUrl(input.tokenId ?? input.assetId!);
  }

  if (!url) {
    throw new Error(
      "Could not resolve agent bundle URL — provide contentUrl, tokenId, or assetId",
    );
  }

  // Normalize ipfs:// → public gateway
  const normalized = url.startsWith("ipfs://")
    ? url.replace(/^ipfs:\/\//, "https://ipfs.io/ipfs/")
    : url;

  const res = await fetch(normalized);
  if (!res.ok) {
    throw new Error(
      `Failed to download agent bundle (${res.status}): ${normalized}`,
    );
  }
  const text = await res.text();
  let bundle: InstallableAgentBundle;
  try {
    bundle = JSON.parse(text) as InstallableAgentBundle;
  } catch (err) {
    throw new Error(
      `Bundle at ${normalized} is not valid JSON: ${(err as Error).message}`,
    );
  }
  if (!bundle || typeof bundle !== "object" || !bundle.name) {
    throw new Error("Bundle JSON is missing required `name` field");
  }
  return bundle;
}

export default registerAgentMarketplaceHandlers;
