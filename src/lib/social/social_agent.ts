/**
 * Autonomous Social Manager agent.
 *
 * Ties the content engine, publisher, and engagement sync together under the
 * human-in-the-loop model:
 *   - `generateForCampaign` drafts posts for a campaign's upcoming calendar
 *     slots. With auto-publish enabled they are scheduled; otherwise they land
 *     in `needs_approval`.
 *   - `autoReplyPass` drafts replies to new engagements. With auto-reply
 *     enabled they are sent (within the daily cap); otherwise they wait for
 *     approval.
 *   - `runAgentTick` is the periodic heartbeat invoked by the scheduler.
 *
 * Settings live in the singleton `social_agent_settings` row (id = 1).
 */

import { and, desc, eq, gte, inArray } from "drizzle-orm";
import log from "electron-log";

import { db } from "@/db";
import {
  type SocialAgentSettingsRow,
  type SocialCampaignCadence,
  type SocialPostContent,
  socialAccounts,
  socialAgentSettings,
  socialCampaigns,
  socialEngagementReplies,
  socialEngagements,
} from "@/db/social_schema";
import {
  type ScheduleId,
  getSchedulerService,
} from "@/lib/scheduler_service";

import {
  generatePostDrafts,
  planCampaignCalendar,
  suggestReply,
} from "./content_engine";
import { sendReply, syncAllEngagements } from "./engagement_sync";
import { notifySocial } from "./notify";
import { createPost, schedulePost } from "./publisher";

const logger = log.scope("social:agent");

// ── Settings ─────────────────────────────────────────────────────────────

/** Read (creating on first use) the singleton agent settings row. */
export async function getAgentSettings(): Promise<SocialAgentSettingsRow> {
  const [row] = await db
    .select()
    .from(socialAgentSettings)
    .where(eq(socialAgentSettings.id, 1))
    .limit(1);
  if (row) return row;
  const [created] = await db
    .insert(socialAgentSettings)
    .values({ id: 1, updatedAt: new Date() })
    .returning();
  return created;
}

export interface AgentSettingsPatch {
  enabled?: boolean;
  autoGenerate?: boolean;
  autoPublish?: boolean;
  autoReply?: boolean;
  defaultTone?: string | null;
  brandVoice?: string | null;
  engagementScanCron?: string | null;
  maxPostsPerDay?: number;
  maxRepliesPerDay?: number;
}

export async function updateAgentSettings(
  patch: AgentSettingsPatch,
): Promise<SocialAgentSettingsRow> {
  const current = await getAgentSettings();
  const [row] = await db
    .update(socialAgentSettings)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(socialAgentSettings.id, 1))
    .returning();

  // Re-derive the engagement scan schedule when the cron or enable state moved.
  const cronChanged =
    patch.engagementScanCron !== undefined &&
    patch.engagementScanCron !== current.engagementScanCron;
  const enableChanged =
    patch.enabled !== undefined && patch.enabled !== current.enabled;
  if (cronChanged || enableChanged) {
    await ensureEngagementScanSchedule(row);
  }
  return row;
}

/** Create / replace / remove the recurring engagement-scan scheduler entry. */
async function ensureEngagementScanSchedule(
  settings: SocialAgentSettingsRow,
): Promise<void> {
  const scheduler = getSchedulerService();
  if (settings.engagementScanScheduleId) {
    try {
      scheduler.remove(settings.engagementScanScheduleId as ScheduleId);
    } catch (err) {
      logger.warn(`could not remove prior scan schedule: ${err}`);
    }
  }
  let newId: string | null = null;
  if (settings.enabled && settings.engagementScanCron) {
    try {
      const sched = scheduler.create({
        name: "social-engagement-scan",
        cron: settings.engagementScanCron,
        action: { toolName: "social.engagement.scan", args: {} },
        ownerId: "social-agent",
        ownerKind: "agent",
        enabled: true,
      });
      newId = sched.id;
    } catch (err) {
      logger.error(`failed to create scan schedule: ${err}`);
      throw new Error(`Invalid engagement scan schedule: ${err}`);
    }
  }
  await db
    .update(socialAgentSettings)
    .set({ engagementScanScheduleId: newId, updatedAt: new Date() })
    .where(eq(socialAgentSettings.id, 1));
}

// ── Content generation ─────────────────────────────────────────────────────

/** Convert a campaign cadence into a recurring 5-field generation cron. */
export function cadenceToGenerationCron(cadence: SocialCampaignCadence): string {
  const slot = cadence.slots?.[0] ?? "08:00";
  const [h, m] = slot.split(":").map((n) => Number.parseInt(n, 10));
  const min = Number.isFinite(m) ? m : 0;
  const hour = Number.isFinite(h) ? h : 8;
  switch (cadence.frequency) {
    case "daily":
      return `${min} ${hour} * * *`;
    case "weekdays":
      return `${min} ${hour} * * 1-5`;
    case "weekly": {
      const days = cadence.daysOfWeek?.length
        ? cadence.daysOfWeek.join(",")
        : "1";
      return `${min} ${hour} * * ${days}`;
    }
    case "custom":
      return cadence.cron ?? `${min} ${hour} * * *`;
    default:
      return `${min} ${hour} * * *`;
  }
}

/**
 * Create / replace / remove the recurring generation schedule for a campaign
 * based on its status + auto-generate flag + cadence.
 */
export async function syncCampaignSchedule(campaignId: number): Promise<void> {
  const [campaign] = await db
    .select()
    .from(socialCampaigns)
    .where(eq(socialCampaigns.id, campaignId))
    .limit(1);
  if (!campaign) return;

  const scheduler = getSchedulerService();
  if (campaign.generationScheduleId) {
    try {
      scheduler.remove(campaign.generationScheduleId as ScheduleId);
    } catch (err) {
      logger.warn(`could not remove campaign schedule: ${err}`);
    }
  }

  let newId: string | null = null;
  const cadence = campaign.cadenceJson as SocialCampaignCadence | null;
  if (campaign.status === "active" && campaign.autoGenerate && cadence) {
    try {
      const sched = scheduler.create({
        name: `social-campaign-${campaignId}`,
        cron: cadenceToGenerationCron(cadence),
        action: {
          toolName: "social.campaign.generate",
          args: { campaignId },
        },
        ownerId: `social-campaign:${campaignId}`,
        ownerKind: "agent",
        enabled: true,
      });
      newId = sched.id;
    } catch (err) {
      logger.error(`failed to create campaign schedule: ${err}`);
      throw new Error(`Invalid campaign cadence: ${err}`);
    }
  }
  await db
    .update(socialCampaigns)
    .set({ generationScheduleId: newId, updatedAt: new Date() })
    .where(eq(socialCampaigns.id, campaignId));
}

function composeContent(
  text: string,
  hashtags: string[],
): SocialPostContent {
  const tags = hashtags.filter(Boolean).map((h) => `#${h}`);
  return { text: tags.length ? `${text}\n\n${tags.join(" ")}` : text };
}

/**
 * Generate drafts for a campaign's next calendar slots. Returns the created
 * post ids. Respects the human-in-the-loop gate (global + campaign auto-publish).
 */
export async function generateForCampaign(
  campaignId: number,
  opts?: { count?: number },
): Promise<{ created: number; postIds: number[] }> {
  const [campaign] = await db
    .select()
    .from(socialCampaigns)
    .where(eq(socialCampaigns.id, campaignId))
    .limit(1);
  if (!campaign) throw new Error(`Campaign ${campaignId} not found.`);

  const topics = (campaign.topicsJson as string[] | null) ?? [];
  if (topics.length === 0) {
    throw new Error(`Campaign ${campaignId} has no topics.`);
  }
  const accountIds = (campaign.targetAccountIdsJson as number[] | null) ?? [];
  if (accountIds.length === 0) {
    throw new Error(`Campaign ${campaignId} has no target accounts.`);
  }

  const settings = await getAgentSettings();
  const cadence: SocialCampaignCadence = (campaign.cadenceJson as
    | SocialCampaignCadence
    | null) ?? { frequency: "weekdays", slots: ["09:00"] };
  const count = Math.min(
    Math.max(opts?.count ?? cadence.slots.length ?? 3, 1),
    Math.max(settings.maxPostsPerDay, 1),
  );
  const slots = planCampaignCalendar({
    cadence,
    fromMs: Date.now(),
    count,
    topics,
  });

  const [firstAccount] = await db
    .select()
    .from(socialAccounts)
    .where(eq(socialAccounts.id, accountIds[0]))
    .limit(1);
  const provider = firstAccount?.provider;
  const autoPublish = campaign.autoPublish && settings.autoPublish;
  const tone = campaign.tone ?? settings.defaultTone ?? undefined;

  const postIds: number[] = [];
  for (const slot of slots) {
    let content: SocialPostContent;
    try {
      const [draft] = await generatePostDrafts({
        topics: [slot.topic],
        provider,
        tone,
        audience: campaign.audience ?? undefined,
        brandVoice: settings.brandVoice ?? undefined,
        count: 1,
        includeImagePrompt: false,
      });
      if (!draft) continue;
      content = composeContent(draft.text, draft.hashtags);
    } catch (err) {
      logger.error(`draft generation failed for campaign ${campaignId}: ${err}`);
      continue;
    }

    const { post } = await createPost({
      content,
      accountIds,
      status: autoPublish ? "draft" : "needs_approval",
      source: "agent",
      campaignId,
      scheduledFor: slot.scheduledFor,
      aiPrompt: slot.topic,
    });
    if (autoPublish) {
      await schedulePost(post.id, slot.scheduledFor);
    }
    postIds.push(post.id);
  }

  if (postIds.length > 0) {
    await notifySocial({
      title: `${postIds.length} ${campaign.name} draft${postIds.length > 1 ? "s" : ""} ready`,
      body: autoPublish
        ? "Auto-scheduled by the social agent."
        : "Awaiting your approval.",
      priority: autoPublish ? "info" : "medium",
      actionUrl: autoPublish ? "/social?tab=calendar" : "/social?tab=approvals",
      actionLabel: "Review",
    });
  }
  return { created: postIds.length, postIds };
}

// ── Auto-reply ─────────────────────────────────────────────────────────────

async function repliesSentToday(): Promise<number> {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const rows = await db
    .select({ id: socialEngagementReplies.id })
    .from(socialEngagementReplies)
    .where(
      and(
        eq(socialEngagementReplies.status, "sent"),
        gte(socialEngagementReplies.sentAt, startOfDay),
      ),
    );
  return rows.length;
}

/**
 * Draft (and, when auto-reply is on, send) replies to new engagements on
 * accounts that opted into auto-reply. Returns counts of drafted vs sent.
 */
export async function autoReplyPass(): Promise<{
  drafted: number;
  sent: number;
}> {
  const settings = await getAgentSettings();
  const accounts = await db
    .select()
    .from(socialAccounts)
    .where(and(eq(socialAccounts.enabled, true), eq(socialAccounts.autoReply, true)));
  if (accounts.length === 0) return { drafted: 0, sent: 0 };

  const accountIds = accounts.map((a) => a.id);
  const pending = await db
    .select()
    .from(socialEngagements)
    .where(
      and(
        inArray(socialEngagements.accountId, accountIds),
        inArray(socialEngagements.status, ["new", "needs_reply"]),
      ),
    )
    .orderBy(desc(socialEngagements.receivedAt))
    .limit(50);

  let remainingSends = settings.autoReply
    ? Math.max(settings.maxRepliesPerDay - (await repliesSentToday()), 0)
    : 0;

  let drafted = 0;
  let sent = 0;
  for (const engagement of pending) {
    const [existing] = await db
      .select({ id: socialEngagementReplies.id })
      .from(socialEngagementReplies)
      .where(eq(socialEngagementReplies.engagementId, engagement.id))
      .limit(1);
    if (existing) continue;

    let replyText: string;
    try {
      replyText = await suggestReply({
        engagementText: engagement.text,
        authorHandle: engagement.authorHandle ?? undefined,
        tone: settings.defaultTone ?? undefined,
        brandVoice: settings.brandVoice ?? undefined,
      });
    } catch (err) {
      logger.warn(`reply suggestion failed for engagement ${engagement.id}: ${err}`);
      continue;
    }
    if (!replyText) continue;

    const willSend = settings.autoReply && remainingSends > 0;
    const now = new Date();
    const [reply] = await db
      .insert(socialEngagementReplies)
      .values({
        engagementId: engagement.id,
        text: replyText,
        status: willSend ? "draft" : "needs_approval",
        source: "agent",
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    drafted++;
    await db
      .update(socialEngagements)
      .set({ status: "needs_reply", updatedAt: now })
      .where(eq(socialEngagements.id, engagement.id));

    if (willSend && reply) {
      try {
        await sendReply(reply.id);
        sent++;
        remainingSends--;
      } catch (err) {
        logger.warn(`auto-reply send failed for reply ${reply.id}: ${err}`);
      }
    }
  }

  if (drafted > 0) {
    await notifySocial({
      title: `${drafted} repl${drafted > 1 ? "ies" : "y"} drafted`,
      body: sent > 0 ? `${sent} sent automatically.` : "Awaiting approval.",
      priority: sent > 0 ? "info" : "medium",
      actionUrl: "/social?tab=inbox",
      actionLabel: "Open inbox",
    });
  }
  return { drafted, sent };
}

// ── Periodic heartbeat ─────────────────────────────────────────────────────

/**
 * Full agent tick: generate for auto-generate campaigns, scan engagements,
 * and run the auto-reply pass. Invoked by the scheduler.
 */
export async function runAgentTick(): Promise<{
  generated: number;
  engagements: number;
  repliesDrafted: number;
  repliesSent: number;
}> {
  const settings = await getAgentSettings();
  if (!settings.enabled) {
    return { generated: 0, engagements: 0, repliesDrafted: 0, repliesSent: 0 };
  }

  let generated = 0;
  if (settings.autoGenerate) {
    const campaigns = await db
      .select({ id: socialCampaigns.id })
      .from(socialCampaigns)
      .where(
        and(
          eq(socialCampaigns.status, "active"),
          eq(socialCampaigns.autoGenerate, true),
        ),
      );
    for (const campaign of campaigns) {
      try {
        const r = await generateForCampaign(campaign.id);
        generated += r.created;
      } catch (err) {
        logger.warn(`campaign ${campaign.id} generation failed: ${err}`);
      }
    }
  }

  const scan = await syncAllEngagements();
  const replies = await autoReplyPass();
  return {
    generated,
    engagements: scan.total,
    repliesDrafted: replies.drafted,
    repliesSent: replies.sent,
  };
}
