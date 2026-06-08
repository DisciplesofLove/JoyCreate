/**
 * Metrics synchronisation.
 *
 * Captures a point-in-time snapshot of engagement metrics for each posted
 * target into `social_metrics`. Snapshots accumulate so the analytics UI can
 * render time-series growth as well as latest totals.
 */

import { and, eq, inArray } from "drizzle-orm";
import log from "electron-log";

import { db } from "@/db";
import {
  type SocialAccountRow,
  socialAccounts,
  socialMetrics,
  socialPostTargets,
  socialPosts,
} from "@/db/social_schema";

import { getSocialAdapter } from "./registry";

const logger = log.scope("social:metrics");

async function loadAccountSafe(
  accountId: number,
): Promise<SocialAccountRow | null> {
  const [row] = await db
    .select()
    .from(socialAccounts)
    .where(eq(socialAccounts.id, accountId))
    .limit(1);
  return row ?? null;
}

/** Capture a metrics snapshot for every posted target of a post. */
export async function syncMetricsForPost(postId: number): Promise<number> {
  const targets = await db
    .select()
    .from(socialPostTargets)
    .where(
      and(
        eq(socialPostTargets.postId, postId),
        eq(socialPostTargets.status, "posted"),
      ),
    );

  let captured = 0;
  for (const target of targets) {
    if (!target.externalPostId) continue;
    const account = await loadAccountSafe(target.accountId);
    if (!account) continue;
    const adapter = getSocialAdapter(account.provider);
    if (!adapter.capabilities.canMetrics || !adapter.fetchMetrics) continue;
    try {
      const m = await adapter.fetchMetrics(
        account.credentialsJson ?? {},
        target.externalPostId,
      );
      await db.insert(socialMetrics).values({
        postTargetId: target.id,
        impressions: m.impressions ?? 0,
        likes: m.likes ?? 0,
        comments: m.comments ?? 0,
        shares: m.shares ?? 0,
        clicks: m.clicks ?? 0,
        capturedAt: Date.now(),
        createdAt: new Date(),
      });
      captured++;
    } catch (err) {
      logger.warn(`metrics fetch failed for target ${target.id}: ${err}`);
    }
  }
  return captured;
}

/** Capture metrics for all posts that have been (at least partially) posted. */
export async function syncAllMetrics(): Promise<number> {
  const posts = await db
    .select({ id: socialPosts.id })
    .from(socialPosts)
    .where(inArray(socialPosts.status, ["posted", "partially_posted"]));
  let total = 0;
  for (const post of posts) {
    total += await syncMetricsForPost(post.id);
  }
  return total;
}
