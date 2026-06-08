/**
 * Social analytics handlers — own post history + live provider metrics.
 *
 * Channels:
 *   social:analytics-overview   dashboard rollup (posts, engagements, metrics)
 *   social:sync-metrics         refresh live metrics from adapters
 *   social:post-metrics         per-target metric time-series for one post
 */

import { desc, eq, inArray } from "drizzle-orm";
import log from "electron-log";

import { syncAllMetrics, syncMetricsForPost } from "@/lib/social/metrics_sync";
import { db } from "../../db";
import {
  type SocialAccountRow,
  type SocialMetricRow,
  type SocialPostTargetRow,
  type SocialProvider,
  socialAccounts,
  socialEngagements,
  socialMetrics,
  socialPostTargets,
  socialPosts,
} from "../../db/social_schema";
import { createLoggedHandler } from "./safe_handle";

const logger = log.scope("social:analytics");
const handle = createLoggedHandler(logger);

export interface SocialMetricTotals {
  impressions: number;
  likes: number;
  comments: number;
  shares: number;
  clicks: number;
}

export interface SocialProviderBreakdown {
  provider: SocialProvider;
  accounts: number;
  posted: number;
  impressions: number;
  likes: number;
}

export interface SocialAnalyticsOverview {
  posts: {
    total: number;
    posted: number;
    scheduled: number;
    drafts: number;
    needsApproval: number;
    failed: number;
  };
  engagements: { total: number; new: number; needsReply: number };
  metrics: SocialMetricTotals;
  byProvider: SocialProviderBreakdown[];
}

export interface SocialMetricPoint {
  capturedAt: number;
  impressions: number;
  likes: number;
  comments: number;
  shares: number;
  clicks: number;
}

export interface SocialPostMetricSeries {
  targetId: number;
  accountId: number;
  provider: SocialProvider | null;
  permalink: string | null;
  points: SocialMetricPoint[];
}

/** Reduce raw snapshots to the latest snapshot per target. */
function latestByTarget(rows: SocialMetricRow[]): Map<number, SocialMetricRow> {
  const map = new Map<number, SocialMetricRow>();
  for (const row of rows) {
    const prev = map.get(row.postTargetId);
    if (!prev || row.capturedAt > prev.capturedAt) {
      map.set(row.postTargetId, row);
    }
  }
  return map;
}

export function registerSocialAnalyticsHandlers(): void {
  handle(
    "social:analytics-overview",
    async (): Promise<SocialAnalyticsOverview> => {
      const [posts, targets, engagements, accounts, metricRows] =
        await Promise.all([
          db.select().from(socialPosts),
          db.select().from(socialPostTargets),
          db.select().from(socialEngagements),
          db.select().from(socialAccounts),
          db.select().from(socialMetrics),
        ]);

      const postStats = {
        total: posts.length,
        posted: 0,
        scheduled: 0,
        drafts: 0,
        needsApproval: 0,
        failed: 0,
      };
      for (const p of posts) {
        if (p.status === "posted" || p.status === "partially_posted") {
          postStats.posted += 1;
        } else if (p.status === "scheduled") postStats.scheduled += 1;
        else if (p.status === "draft") postStats.drafts += 1;
        else if (p.status === "needs_approval") postStats.needsApproval += 1;
        else if (p.status === "failed") postStats.failed += 1;
      }

      const engagementStats = {
        total: engagements.length,
        new: engagements.filter((e) => e.status === "new").length,
        needsReply: engagements.filter((e) => e.status === "needs_reply")
          .length,
      };

      const latest = latestByTarget(metricRows);
      const metrics: SocialMetricTotals = {
        impressions: 0,
        likes: 0,
        comments: 0,
        shares: 0,
        clicks: 0,
      };
      for (const m of latest.values()) {
        metrics.impressions += m.impressions;
        metrics.likes += m.likes;
        metrics.comments += m.comments;
        metrics.shares += m.shares;
        metrics.clicks += m.clicks;
      }

      const providerByAccount = new Map<number, SocialProvider>(
        accounts.map((a: SocialAccountRow) => [a.id, a.provider]),
      );
      const targetById = new Map<number, SocialPostTargetRow>(
        targets.map((t: SocialPostTargetRow) => [t.id, t]),
      );
      const breakdown = new Map<SocialProvider, SocialProviderBreakdown>();
      const ensure = (provider: SocialProvider): SocialProviderBreakdown => {
        let b = breakdown.get(provider);
        if (!b) {
          b = {
            provider,
            accounts: 0,
            posted: 0,
            impressions: 0,
            likes: 0,
          };
          breakdown.set(provider, b);
        }
        return b;
      };
      for (const a of accounts) ensure(a.provider).accounts += 1;
      for (const t of targets) {
        if (t.status !== "posted") continue;
        const provider = providerByAccount.get(t.accountId);
        if (provider) ensure(provider).posted += 1;
      }
      for (const m of latest.values()) {
        const target = targetById.get(m.postTargetId);
        if (!target) continue;
        const provider = providerByAccount.get(target.accountId);
        if (!provider) continue;
        const b = ensure(provider);
        b.impressions += m.impressions;
        b.likes += m.likes;
      }

      return {
        posts: postStats,
        engagements: engagementStats,
        metrics,
        byProvider: [...breakdown.values()],
      };
    },
  );

  handle(
    "social:sync-metrics",
    async (
      _e,
      input?: { postId?: number },
    ): Promise<{ snapshots: number }> => {
      if (typeof input?.postId === "number") {
        const snapshots = await syncMetricsForPost(input.postId);
        return { snapshots };
      }
      const snapshots = await syncAllMetrics();
      return { snapshots };
    },
  );

  handle(
    "social:post-metrics",
    async (
      _e,
      input: { postId: number },
    ): Promise<SocialPostMetricSeries[]> => {
      const targets = await db
        .select()
        .from(socialPostTargets)
        .where(eq(socialPostTargets.postId, input.postId));
      if (targets.length === 0) return [];

      const targetIds = targets.map((t) => t.id);
      const accountIds = [...new Set(targets.map((t) => t.accountId))];
      const accounts = await db
        .select()
        .from(socialAccounts)
        .where(inArray(socialAccounts.id, accountIds));
      const providerByAccount = new Map<number, SocialProvider>(
        accounts.map((a: SocialAccountRow) => [a.id, a.provider]),
      );

      const metricRows = await db
        .select()
        .from(socialMetrics)
        .where(inArray(socialMetrics.postTargetId, targetIds))
        .orderBy(desc(socialMetrics.capturedAt));
      const pointsByTarget = new Map<number, SocialMetricPoint[]>();
      for (const m of metricRows) {
        const list = pointsByTarget.get(m.postTargetId) ?? [];
        list.push({
          capturedAt: m.capturedAt,
          impressions: m.impressions,
          likes: m.likes,
          comments: m.comments,
          shares: m.shares,
          clicks: m.clicks,
        });
        pointsByTarget.set(m.postTargetId, list);
      }

      return targets.map((t) => ({
        targetId: t.id,
        accountId: t.accountId,
        provider: providerByAccount.get(t.accountId) ?? null,
        permalink: t.permalink,
        points: (pointsByTarget.get(t.id) ?? []).reverse(),
      }));
    },
  );
}
