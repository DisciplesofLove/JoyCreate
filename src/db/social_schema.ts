/**
 * Social media management schema.
 *
 * This powers the agent-managed social suite: multi-platform accounts,
 * AI-generated posts, a scheduling calendar, cross-posting fan-out, a unified
 * engagement inbox with (optionally automated) replies, time-series metrics,
 * campaigns, and the autonomous Social Manager Agent settings.
 *
 * Secrets (OAuth tokens) are persisted via the secrets vault and referenced by
 * `vaultSecretId`; only public display metadata lives in `credentialsJson`.
 *
 * Tables
 *   - `social_accounts`            connected provider accounts
 *   - `social_campaigns`           recurring content programs (topics + cadence)
 *   - `social_posts`               canonical post entity (draft → posted)
 *   - `social_post_targets`        per-account publish fan-out + result
 *   - `social_engagements`         inbound comments / mentions / DMs (inbox)
 *   - `social_engagement_replies`  drafted / sent replies to engagements
 *   - `social_metrics`             time-series engagement snapshots per target
 *   - `social_agent_settings`      singleton autonomous-agent configuration
 */

import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// ── Shared literal unions ────────────────────────────────────────────────

export type SocialProvider =
  | "twitter"
  | "linkedin"
  | "instagram"
  | "facebook"
  | "reddit";

export type SocialPostStatus =
  | "draft"
  | "needs_approval"
  | "scheduled"
  | "publishing"
  | "posted"
  | "partially_posted"
  | "failed"
  | "cancelled";

export type SocialPostSource = "manual" | "ai" | "agent";

export type SocialTargetStatus =
  | "pending"
  | "publishing"
  | "posted"
  | "failed"
  | "skipped";

export type SocialEngagementType =
  | "comment"
  | "mention"
  | "reply"
  | "dm"
  | "review";

export type SocialEngagementStatus =
  | "new"
  | "needs_reply"
  | "replied"
  | "ignored"
  | "archived";

export type SocialReplyStatus =
  | "draft"
  | "needs_approval"
  | "sending"
  | "sent"
  | "failed"
  | "dismissed";

export type SocialReplySource = "manual" | "ai" | "agent";

export type SocialSentiment = "positive" | "neutral" | "negative" | "mixed";

export type SocialCampaignStatus =
  | "active"
  | "paused"
  | "completed"
  | "archived";

// ── Shared JSON shapes ───────────────────────────────────────────────────

export interface SocialAccountCredentials {
  /** Vault secret id holding the real OAuth token blob. */
  vaultSecretId?: string;
  /** Public display info shown in the UI. */
  handle?: string;
  displayName?: string;
  avatarUrl?: string;
  /** OAuth scopes granted. */
  scopes?: string[];
  /** Token expiry (ms epoch); null = no expiry / refresh-managed. */
  expiresAt?: number | null;
  /** Provider-specific public extras (page id, default subreddit, etc.). */
  extra?: Record<string, unknown>;
}

export interface SocialMediaItem {
  /** Local path or remote URL of the asset. */
  url: string;
  type?: "image" | "video" | "gif";
  altText?: string;
  mimeType?: string;
}

export interface SocialPostContent {
  /** Default text used for every target unless overridden per platform. */
  text: string;
  /** Structured media attachments. */
  media?: SocialMediaItem[];
  /** @deprecated Use {@link media}. Retained for backwards compatibility. */
  mediaUrls?: string[];
  /** Optional per-provider text / option overrides. */
  perPlatform?: Partial<
    Record<SocialProvider, { text?: string; extras?: Record<string, unknown> }>
  >;
  /** Provider-agnostic extras (link card, first-comment, poll, etc.). */
  extras?: Record<string, unknown>;
}

/** @deprecated Alias kept for callers; prefer {@link SocialPostContent}. */
export type SocialPostPayload = SocialPostContent;

export interface SocialCampaignCadence {
  /** "daily" | "weekdays" | "weekly" | "custom" */
  frequency: "daily" | "weekdays" | "weekly" | "custom";
  /** Local HH:MM posting slots, e.g. ["09:00","17:00"]. */
  slots: string[];
  /** For "weekly": 0-6 (Sun-Sat) days to post on. */
  daysOfWeek?: number[];
  /** Raw 5-field cron override when frequency === "custom". */
  cron?: string;
  /** Target timezone label for display (scheduling uses local machine time). */
  timezone?: string;
}

// ── Tables ───────────────────────────────────────────────────────────────

export const socialAccounts = sqliteTable("social_accounts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  provider: text("provider").$type<SocialProvider>().notNull(),
  /** Provider-side user id (handle, URN, etc.) for de-duplication. */
  externalId: text("external_id").notNull(),
  /** Human-readable name shown in pickers. */
  label: text("label").notNull(),
  credentialsJson: text("credentials_json", { mode: "json" }).$type<
    SocialAccountCredentials | null
  >(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  /** Auto-reply to inbound engagements for this account (agent-gated). */
  autoReply: integer("auto_reply", { mode: "boolean" })
    .notNull()
    .default(false),
  /** Token health, surfaced in the accounts UI. */
  tokenStatus: text("token_status", {
    enum: ["ok", "expiring", "expired", "none"],
  })
    .notNull()
    .default("none"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

export const socialCampaigns = sqliteTable("social_campaigns", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  description: text("description"),
  status: text("status", {
    enum: ["active", "paused", "completed", "archived"],
  })
    .notNull()
    .default("active"),
  /** Topics / themes the agent generates content about. */
  topicsJson: text("topics_json", { mode: "json" }).$type<string[]>().notNull(),
  /** Voice / tone, e.g. "professional", "casual", "witty". */
  tone: text("tone"),
  audience: text("audience"),
  /** Posting cadence definition. */
  cadenceJson: text("cadence_json", { mode: "json" }).$type<
    SocialCampaignCadence | null
  >(),
  /** Accounts this campaign publishes to. */
  targetAccountIdsJson: text("target_account_ids_json", { mode: "json" })
    .$type<number[]>()
    .notNull(),
  /** Generate drafts automatically on cadence. */
  autoGenerate: integer("auto_generate", { mode: "boolean" })
    .notNull()
    .default(false),
  /** Publish generated drafts without human approval. */
  autoPublish: integer("auto_publish", { mode: "boolean" })
    .notNull()
    .default(false),
  /** Scheduler schedule id driving recurring generation. */
  generationScheduleId: text("generation_schedule_id"),
  startAt: integer("start_at"),
  endAt: integer("end_at"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

export const socialPosts = sqliteTable("social_posts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  /** Optional owning campaign. */
  campaignId: integer("campaign_id"),
  /** Canonical post content. */
  contentJson: text("content_json", { mode: "json" })
    .$type<SocialPostContent>()
    .notNull(),
  status: text("status", {
    enum: [
      "draft",
      "needs_approval",
      "scheduled",
      "publishing",
      "posted",
      "partially_posted",
      "failed",
      "cancelled",
    ],
  })
    .notNull()
    .default("draft"),
  source: text("source", { enum: ["manual", "ai", "agent"] })
    .notNull()
    .default("manual"),
  /** Unix-ms timestamp the post is due (null = draft / immediate). */
  scheduledFor: integer("scheduled_for"),
  /** Scheduler one-shot schedule id. */
  scheduleId: text("schedule_id"),
  approvedAt: integer("approved_at", { mode: "timestamp" }),
  approvedBy: text("approved_by"),
  /** AI provenance. */
  aiModel: text("ai_model"),
  aiPrompt: text("ai_prompt"),
  errorMessage: text("error_message"),
  postedAt: integer("posted_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

export const socialPostTargets = sqliteTable("social_post_targets", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  postId: integer("post_id").notNull(),
  accountId: integer("account_id").notNull(),
  status: text("status", {
    enum: ["pending", "publishing", "posted", "failed", "skipped"],
  })
    .notNull()
    .default("pending"),
  /** Provider-returned post id (URL or URN) on success. */
  externalPostId: text("external_post_id"),
  permalink: text("permalink"),
  errorMessage: text("error_message"),
  postedAt: integer("posted_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

export const socialEngagements = sqliteTable("social_engagements", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  accountId: integer("account_id").notNull(),
  /** Our published target this engagement is attached to, when known. */
  postTargetId: integer("post_target_id"),
  type: text("type", {
    enum: ["comment", "mention", "reply", "dm", "review"],
  }).notNull(),
  /** Provider-side id for de-duplication. */
  externalId: text("external_id").notNull(),
  /** External post / thread the engagement belongs to. */
  externalParentId: text("external_parent_id"),
  authorHandle: text("author_handle"),
  authorDisplayName: text("author_display_name"),
  text: text("text").notNull(),
  permalink: text("permalink"),
  sentiment: text("sentiment", {
    enum: ["positive", "neutral", "negative", "mixed"],
  }),
  status: text("status", {
    enum: ["new", "needs_reply", "replied", "ignored", "archived"],
  })
    .notNull()
    .default("new"),
  raw: text("raw", { mode: "json" }).$type<unknown>(),
  /** Unix-ms when the engagement was created on-platform. */
  receivedAt: integer("received_at").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

export const socialEngagementReplies = sqliteTable(
  "social_engagement_replies",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    engagementId: integer("engagement_id").notNull(),
    text: text("text").notNull(),
    status: text("status", {
      enum: [
        "draft",
        "needs_approval",
        "sending",
        "sent",
        "failed",
        "dismissed",
      ],
    })
      .notNull()
      .default("draft"),
    source: text("source", { enum: ["manual", "ai", "agent"] })
      .notNull()
      .default("manual"),
    externalReplyId: text("external_reply_id"),
    errorMessage: text("error_message"),
    approvedAt: integer("approved_at", { mode: "timestamp" }),
    sentAt: integer("sent_at", { mode: "timestamp" }),
    aiModel: text("ai_model"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
);

export const socialMetrics = sqliteTable("social_metrics", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  postTargetId: integer("post_target_id").notNull(),
  impressions: integer("impressions").notNull().default(0),
  likes: integer("likes").notNull().default(0),
  comments: integer("comments").notNull().default(0),
  shares: integer("shares").notNull().default(0),
  clicks: integer("clicks").notNull().default(0),
  /** Unix-ms snapshot capture time. */
  capturedAt: integer("captured_at").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

export const socialAgentSettings = sqliteTable("social_agent_settings", {
  /** Singleton row (id = 1). */
  id: integer("id").primaryKey({ autoIncrement: true }),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
  autoGenerate: integer("auto_generate", { mode: "boolean" })
    .notNull()
    .default(false),
  autoPublish: integer("auto_publish", { mode: "boolean" })
    .notNull()
    .default(false),
  autoReply: integer("auto_reply", { mode: "boolean" })
    .notNull()
    .default(false),
  defaultTone: text("default_tone"),
  /** Brand voice / system guidance injected into generation prompts. */
  brandVoice: text("brand_voice"),
  /** Cron driving the engagement scanner. */
  engagementScanCron: text("engagement_scan_cron"),
  engagementScanScheduleId: text("engagement_scan_schedule_id"),
  /** Daily guardrails. */
  maxPostsPerDay: integer("max_posts_per_day").notNull().default(10),
  maxRepliesPerDay: integer("max_replies_per_day").notNull().default(50),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

// ── Inferred row types ───────────────────────────────────────────────────

export type SocialAccountRow = typeof socialAccounts.$inferSelect;
export type SocialAccountInsert = typeof socialAccounts.$inferInsert;
export type SocialCampaignRow = typeof socialCampaigns.$inferSelect;
export type SocialCampaignInsert = typeof socialCampaigns.$inferInsert;
export type SocialPostRow = typeof socialPosts.$inferSelect;
export type SocialPostInsert = typeof socialPosts.$inferInsert;
export type SocialPostTargetRow = typeof socialPostTargets.$inferSelect;
export type SocialPostTargetInsert = typeof socialPostTargets.$inferInsert;
export type SocialEngagementRow = typeof socialEngagements.$inferSelect;
export type SocialEngagementInsert = typeof socialEngagements.$inferInsert;
export type SocialEngagementReplyRow =
  typeof socialEngagementReplies.$inferSelect;
export type SocialEngagementReplyInsert =
  typeof socialEngagementReplies.$inferInsert;
export type SocialMetricRow = typeof socialMetrics.$inferSelect;
export type SocialMetricInsert = typeof socialMetrics.$inferInsert;
export type SocialAgentSettingsRow = typeof socialAgentSettings.$inferSelect;
export type SocialAgentSettingsInsert = typeof socialAgentSettings.$inferInsert;
