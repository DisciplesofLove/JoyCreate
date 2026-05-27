/**
 * Unified Command Center Handlers
 *
 * Aggregator that powers `/command-center` — one IPC call returns the four
 * panels the page renders:
 *
 *   1. Active agents
 *   2. 24h agent-run success / fail (from `usageEvents`)
 *   3. Token spend by model (last 24h, from `usageEvents`)
 *   4. Scheduled-job upcoming fires (from SchedulerService)
 *   5. MCP server / call counts
 *
 * Throws on error.
 */

import log from "electron-log";
import { sql, gte, and, eq } from "drizzle-orm";

import { db } from "../../db";
import { agents, usageEvents, mcpServers } from "../../db/schema";
import { getSchedulerService } from "@/lib/scheduler_service";
import { createLoggedHandler } from "./safe_handle";

const logger = log.scope("command_center");
const handle = createLoggedHandler(logger);

export interface CommandCenterOverview {
  generatedAt: number;
  agents: {
    total: number;
    active: number;
    draft: number;
    paused: number;
    archived: number;
  };
  runs24h: {
    total: number;
    success: number;
    failed: number;
    successRate: number; // 0..1
  };
  tokenSpend24h: {
    totalInputTokens: number;
    totalOutputTokens: number;
    byModel: Array<{
      modelId: string;
      inputTokens: number;
      outputTokens: number;
      events: number;
    }>;
  };
  scheduledJobs: {
    total: number;
    enabled: number;
    upcoming: Array<{
      id: string;
      name: string;
      cron: string;
      nextRunAt: number | null;
      enabled: boolean;
    }>;
  };
  mcp: {
    serverCount: number;
    enabledServers: number;
    callCount24h: number;
  };
}

const DAY_SECONDS = 24 * 60 * 60;

async function buildOverview(): Promise<CommandCenterOverview> {
  const nowSec = Math.floor(Date.now() / 1000);
  const since = new Date((nowSec - DAY_SECONDS) * 1000);

  const [
    agentRows,
    runRows,
    spendRows,
    mcpRows,
    mcpCallRow,
  ] = await Promise.all([
    db
      .select({
        status: agents.status,
        count: sql<number>`count(*)`,
      })
      .from(agents)
      .groupBy(agents.status),
    db
      .select({
        success: sql<number>`sum(case when ${usageEvents.eventType} != 'error' then 1 else 0 end)`,
        failed: sql<number>`sum(case when ${usageEvents.eventType} = 'error' then 1 else 0 end)`,
        total: sql<number>`count(*)`,
      })
      .from(usageEvents)
      .where(gte(usageEvents.createdAt, since)),
    db
      .select({
        modelId: usageEvents.modelId,
        inputTokens: sql<number>`coalesce(sum(${usageEvents.inputTokens}), 0)`,
        outputTokens: sql<number>`coalesce(sum(${usageEvents.outputTokens}), 0)`,
        events: sql<number>`count(*)`,
      })
      .from(usageEvents)
      .where(gte(usageEvents.createdAt, since))
      .groupBy(usageEvents.modelId),
    db
      .select({
        total: sql<number>`count(*)`,
        enabled: sql<number>`sum(case when ${mcpServers.enabled} = 1 then 1 else 0 end)`,
      })
      .from(mcpServers),
    db
      .select({
        count: sql<number>`count(*)`,
      })
      .from(usageEvents)
      .where(
        and(
          gte(usageEvents.createdAt, since),
          eq(usageEvents.eventType, "api_call"),
        ),
      ),
  ]);

  const agentCounts = {
    total: 0,
    active: 0,
    draft: 0,
    paused: 0,
    archived: 0,
  };
  for (const row of agentRows) {
    const c = Number(row.count) || 0;
    agentCounts.total += c;
    const key = row.status as keyof typeof agentCounts | undefined;
    if (key && key !== "total" && key in agentCounts) {
      agentCounts[key] += c;
    }
  }

  const runs = runRows[0] ?? { success: 0, failed: 0, total: 0 };
  const successN = Number(runs.success) || 0;
  const failedN = Number(runs.failed) || 0;
  const totalN = Number(runs.total) || 0;

  const byModel = spendRows
    .map((r) => ({
      modelId: r.modelId ?? "(unknown)",
      inputTokens: Number(r.inputTokens) || 0,
      outputTokens: Number(r.outputTokens) || 0,
      events: Number(r.events) || 0,
    }))
    .sort(
      (a, b) =>
        b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens),
    );
  const totalInputTokens = byModel.reduce((s, r) => s + r.inputTokens, 0);
  const totalOutputTokens = byModel.reduce((s, r) => s + r.outputTokens, 0);

  // Scheduler
  let scheduledJobs: CommandCenterOverview["scheduledJobs"] = {
    total: 0,
    enabled: 0,
    upcoming: [],
  };
  try {
    const sched = getSchedulerService();
    await sched.initialize();
    const all = sched.list();
    const upcoming = [...all]
      .filter((s) => s.enabled && s.nextRunAt !== null)
      .sort((a, b) => (a.nextRunAt ?? 0) - (b.nextRunAt ?? 0))
      .slice(0, 10)
      .map((s) => ({
        id: s.id,
        name: s.name,
        cron: s.cron,
        nextRunAt: s.nextRunAt,
        enabled: s.enabled,
      }));
    scheduledJobs = {
      total: all.length,
      enabled: all.filter((s) => s.enabled).length,
      upcoming,
    };
  } catch (err) {
    logger.warn("Scheduler unavailable for command center overview", err);
  }

  const mcp = mcpRows[0] ?? { total: 0, enabled: 0 };
  const mcpCalls = mcpCallRow[0] ?? { count: 0 };

  return {
    generatedAt: Date.now(),
    agents: agentCounts,
    runs24h: {
      total: totalN,
      success: successN,
      failed: failedN,
      successRate: totalN > 0 ? successN / totalN : 0,
    },
    tokenSpend24h: {
      totalInputTokens,
      totalOutputTokens,
      byModel: byModel.slice(0, 10),
    },
    scheduledJobs,
    mcp: {
      serverCount: Number(mcp.total) || 0,
      enabledServers: Number(mcp.enabled) || 0,
      callCount24h: Number(mcpCalls.count) || 0,
    },
  };
}

export function registerCommandCenterHandlers(): void {
  handle("command-center:get-overview", async (): Promise<CommandCenterOverview> => {
    return buildOverview();
  });
}
