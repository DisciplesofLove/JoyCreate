/**
 * Social agent handlers — autonomy settings + status + manual run.
 *
 * Channels:
 *   social:get-agent-settings   read the singleton agent settings
 *   social:set-agent-settings   patch agent settings (re-derives schedules)
 *   social:agent-status         live counts for the agent dashboard
 *   social:agent-run-now        run one agent tick immediately
 */

import { eq, inArray } from "drizzle-orm";
import log from "electron-log";

import {
  type AgentSettingsPatch,
  getAgentSettings,
  runAgentTick,
  updateAgentSettings,
} from "@/lib/social/social_agent";
import { db } from "../../db";
import {
  type SocialAgentSettingsRow,
  socialCampaigns,
  socialEngagementReplies,
  socialEngagements,
  socialPosts,
} from "../../db/social_schema";
import { createLoggedHandler } from "./safe_handle";

const logger = log.scope("social:agent");
const handle = createLoggedHandler(logger);

export interface SocialAgentSettingsDto {
  enabled: boolean;
  autoGenerate: boolean;
  autoPublish: boolean;
  autoReply: boolean;
  defaultTone: string | null;
  brandVoice: string | null;
  engagementScanCron: string | null;
  maxPostsPerDay: number;
  maxRepliesPerDay: number;
  updatedAt: number;
}

export interface SocialAgentStatusDto {
  enabled: boolean;
  autoGenerate: boolean;
  autoPublish: boolean;
  autoReply: boolean;
  activeCampaigns: number;
  scheduledPosts: number;
  pendingPostApprovals: number;
  pendingReplyApprovals: number;
  newEngagements: number;
}

function toSettingsDto(row: SocialAgentSettingsRow): SocialAgentSettingsDto {
  return {
    enabled: row.enabled,
    autoGenerate: row.autoGenerate,
    autoPublish: row.autoPublish,
    autoReply: row.autoReply,
    defaultTone: row.defaultTone,
    brandVoice: row.brandVoice,
    engagementScanCron: row.engagementScanCron,
    maxPostsPerDay: row.maxPostsPerDay,
    maxRepliesPerDay: row.maxRepliesPerDay,
    updatedAt: row.updatedAt.getTime(),
  };
}

export function registerSocialAgentHandlers(): void {
  handle(
    "social:get-agent-settings",
    async (): Promise<SocialAgentSettingsDto> => {
      return toSettingsDto(await getAgentSettings());
    },
  );

  handle(
    "social:set-agent-settings",
    async (
      _e,
      patch: AgentSettingsPatch,
    ): Promise<SocialAgentSettingsDto> => {
      if (
        patch.maxPostsPerDay !== undefined &&
        (!Number.isFinite(patch.maxPostsPerDay) || patch.maxPostsPerDay < 0)
      ) {
        throw new Error("maxPostsPerDay must be a non-negative number.");
      }
      if (
        patch.maxRepliesPerDay !== undefined &&
        (!Number.isFinite(patch.maxRepliesPerDay) || patch.maxRepliesPerDay < 0)
      ) {
        throw new Error("maxRepliesPerDay must be a non-negative number.");
      }
      return toSettingsDto(await updateAgentSettings(patch));
    },
  );

  handle("social:agent-status", async (): Promise<SocialAgentStatusDto> => {
    const settings = await getAgentSettings();
    const [campaigns, posts, replies, engagements] = await Promise.all([
      db
        .select({ id: socialCampaigns.id })
        .from(socialCampaigns)
        .where(eq(socialCampaigns.status, "active")),
      db.select({ id: socialPosts.id, status: socialPosts.status }).from(socialPosts),
      db
        .select({ id: socialEngagementReplies.id })
        .from(socialEngagementReplies)
        .where(eq(socialEngagementReplies.status, "needs_approval")),
      db
        .select({ id: socialEngagements.id })
        .from(socialEngagements)
        .where(
          inArray(socialEngagements.status, ["new", "needs_reply"]),
        ),
    ]);

    return {
      enabled: settings.enabled,
      autoGenerate: settings.autoGenerate,
      autoPublish: settings.autoPublish,
      autoReply: settings.autoReply,
      activeCampaigns: campaigns.length,
      scheduledPosts: posts.filter((p) => p.status === "scheduled").length,
      pendingPostApprovals: posts.filter((p) => p.status === "needs_approval")
        .length,
      pendingReplyApprovals: replies.length,
      newEngagements: engagements.length,
    };
  });

  handle(
    "social:agent-run-now",
    async (): Promise<{
      generated: number;
      engagements: number;
      repliesDrafted: number;
      repliesSent: number;
    }> => {
      return runAgentTick();
    },
  );
}
