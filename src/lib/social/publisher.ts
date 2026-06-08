/**
 * Post publishing engine.
 *
 * A `social_posts` row fans out to one `social_post_targets` row per account.
 * `publishPost` walks the pending targets, calls each provider adapter, records
 * per-target success/failure, and rolls the results up into the post status
 * (`posted` / `partially_posted` / `failed`). Used by both the immediate
 * "publish now" path and the scheduler-fired `social.post` task.
 */

import { eq } from "drizzle-orm";
import log from "electron-log";

import { db } from "@/db";
import {
  type SocialAccountRow,
  type SocialPostContent,
  type SocialPostRow,
  type SocialPostTargetRow,
  type SocialTargetStatus,
  socialAccounts,
  socialPostTargets,
  socialPosts,
} from "@/db/social_schema";
import {
  type ScheduleId,
  getSchedulerService,
} from "@/lib/scheduler_service";

import { notifySocial } from "./notify";
import { getSocialAdapter } from "./registry";

const logger = log.scope("social:publisher");

export interface PublishTargetResult {
  accountId: number;
  status: SocialTargetStatus;
  externalPostId?: string;
  permalink?: string;
  error?: string;
}

export interface PublishResult {
  postId: number;
  status: SocialPostRow["status"];
  posted: number;
  failed: number;
  targets: PublishTargetResult[];
}

async function loadAccount(accountId: number): Promise<SocialAccountRow> {
  const [row] = await db
    .select()
    .from(socialAccounts)
    .where(eq(socialAccounts.id, accountId))
    .limit(1);
  if (!row) throw new Error(`Account ${accountId} not found.`);
  if (!row.enabled) throw new Error(`Account ${accountId} is disabled.`);
  return row;
}

/** Apply a per-platform text override when one is present. */
function contentForProvider(
  content: SocialPostContent,
  provider: SocialAccountRow["provider"],
): SocialPostContent {
  const override = content.perPlatform?.[provider]?.text;
  return override ? { ...content, text: override } : content;
}

/**
 * Create a draft post and its per-account targets. Status defaults to
 * `draft`; callers schedule / publish / request-approval afterwards.
 */
export async function createPost(input: {
  content: SocialPostContent;
  accountIds: number[];
  status?: SocialPostRow["status"];
  source?: SocialPostRow["source"];
  scheduledFor?: number | null;
  campaignId?: number | null;
  aiModel?: string | null;
  aiPrompt?: string | null;
}): Promise<{ post: SocialPostRow; targets: SocialPostTargetRow[] }> {
  if (!input.content?.text?.trim()) {
    throw new Error("Post text is required.");
  }
  if (!input.accountIds || input.accountIds.length === 0) {
    throw new Error("At least one target account is required.");
  }
  const now = new Date();
  const [post] = await db
    .insert(socialPosts)
    .values({
      campaignId: input.campaignId ?? null,
      contentJson: input.content,
      status: input.status ?? "draft",
      source: input.source ?? "manual",
      scheduledFor: input.scheduledFor ?? null,
      aiModel: input.aiModel ?? null,
      aiPrompt: input.aiPrompt ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  if (!post) throw new Error("Failed to create post.");

  const uniqueAccountIds = Array.from(new Set(input.accountIds));
  const targets = await db
    .insert(socialPostTargets)
    .values(
      uniqueAccountIds.map((accountId) => ({
        postId: post.id,
        accountId,
        status: "pending" as const,
        createdAt: now,
        updatedAt: now,
      })),
    )
    .returning();
  return { post, targets };
}

/** Convert a unix-ms timestamp into a one-shot 5-field cron expression. */
function timestampToCron(ms: number): string {
  const d = new Date(ms);
  d.setSeconds(0, 0);
  return `${d.getMinutes()} ${d.getHours()} ${d.getDate()} ${d.getMonth() + 1} *`;
}

/** Cancel a previously-registered scheduler entry, ignoring "not found". */
export function cancelSchedule(scheduleId: string | null | undefined): void {
  if (!scheduleId) return;
  try {
    getSchedulerService().remove(scheduleId as ScheduleId);
  } catch (err) {
    logger.warn(`scheduler remove failed for ${scheduleId}: ${err}`);
  }
}

/**
 * Mark a post `scheduled` and register a one-shot scheduler entry that fires
 * the `social.post` task at the requested time.
 */
export async function schedulePost(
  postId: number,
  scheduledFor: number,
): Promise<SocialPostRow> {
  if (!Number.isFinite(scheduledFor) || scheduledFor <= Date.now()) {
    throw new Error("scheduledFor must be a future unix-ms timestamp.");
  }
  const [post] = await db
    .select()
    .from(socialPosts)
    .where(eq(socialPosts.id, postId))
    .limit(1);
  if (!post) throw new Error(`Post ${postId} not found.`);

  cancelSchedule(post.scheduleId);
  const sched = getSchedulerService().create({
    name: `social-post-${postId}`,
    cron: timestampToCron(scheduledFor),
    action: { toolName: "social.post", args: { postId } },
    ownerId: `social-post:${postId}`,
    ownerKind: "agent",
    enabled: true,
  });
  const [row] = await db
    .update(socialPosts)
    .set({
      status: "scheduled",
      scheduledFor,
      scheduleId: sched.id,
      errorMessage: null,
      updatedAt: new Date(),
    })
    .where(eq(socialPosts.id, postId))
    .returning();
  return row;
}

/**
 * Publish a post to all of its pending targets. Idempotent for already-posted
 * targets (they are skipped, enabling retry of only the failed ones).
 */
export async function publishPost(postId: number): Promise<PublishResult> {
  const [post] = await db
    .select()
    .from(socialPosts)
    .where(eq(socialPosts.id, postId))
    .limit(1);
  if (!post) throw new Error(`Post ${postId} not found.`);
  if (post.status === "cancelled") {
    throw new Error(`Post ${postId} is cancelled.`);
  }

  const targets = await db
    .select()
    .from(socialPostTargets)
    .where(eq(socialPostTargets.postId, postId));
  if (targets.length === 0) {
    throw new Error(`Post ${postId} has no target accounts.`);
  }

  await db
    .update(socialPosts)
    .set({ status: "publishing", updatedAt: new Date() })
    .where(eq(socialPosts.id, postId));

  // The post's one-shot schedule (if any) has now fired; clear its handle.
  cancelSchedule(post.scheduleId);

  const content = post.contentJson as SocialPostContent;
  const results: PublishTargetResult[] = [];

  for (const target of targets) {
    if (target.status === "posted" || target.status === "skipped") {
      results.push({
        accountId: target.accountId,
        status: target.status,
        externalPostId: target.externalPostId ?? undefined,
        permalink: target.permalink ?? undefined,
      });
      continue;
    }

    await db
      .update(socialPostTargets)
      .set({ status: "publishing", updatedAt: new Date() })
      .where(eq(socialPostTargets.id, target.id));

    try {
      const account = await loadAccount(target.accountId);
      const adapter = getSocialAdapter(account.provider);
      if (!adapter.capabilities.canPublish) {
        throw new Error(`${account.provider} does not support publishing.`);
      }
      const res = await adapter.post(
        account.credentialsJson ?? {},
        contentForProvider(content, account.provider),
      );
      await db
        .update(socialPostTargets)
        .set({
          status: "posted",
          externalPostId: res.externalPostId,
          permalink: res.permalink ?? null,
          errorMessage: null,
          postedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(socialPostTargets.id, target.id));
      results.push({
        accountId: target.accountId,
        status: "posted",
        externalPostId: res.externalPostId,
        permalink: res.permalink,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await db
        .update(socialPostTargets)
        .set({ status: "failed", errorMessage: msg, updatedAt: new Date() })
        .where(eq(socialPostTargets.id, target.id));
      results.push({ accountId: target.accountId, status: "failed", error: msg });
      logger.error(`post ${postId} target ${target.id} failed: ${msg}`);
    }
  }

  const posted = results.filter((r) => r.status === "posted").length;
  const failed = results.filter((r) => r.status === "failed").length;
  const status: SocialPostRow["status"] =
    posted > 0 && failed === 0
      ? "posted"
      : posted > 0
        ? "partially_posted"
        : "failed";

  await db
    .update(socialPosts)
    .set({
      status,
      scheduleId: null,
      postedAt: posted > 0 ? new Date() : null,
      errorMessage: failed > 0 ? `${failed} target(s) failed to publish.` : null,
      updatedAt: new Date(),
    })
    .where(eq(socialPosts.id, postId));

  const preview = content.text.slice(0, 100);
  if (status === "posted") {
    await notifySocial({
      title: "Post published",
      body: preview,
      priority: "info",
      actionUrl: "/social",
      actionLabel: "View",
    });
  } else if (status === "partially_posted") {
    await notifySocial({
      title: "Post partially published",
      body: `${posted} succeeded, ${failed} failed — ${preview}`,
      priority: "high",
      actionUrl: "/social",
      actionLabel: "Review",
    });
  } else {
    await notifySocial({
      title: "Post failed to publish",
      body: preview,
      priority: "high",
      actionUrl: "/social",
      actionLabel: "Retry",
    });
  }

  return { postId, status, posted, failed, targets: results };
}
