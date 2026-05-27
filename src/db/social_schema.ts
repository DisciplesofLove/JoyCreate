/**
 * Social posting schema.
 *
 * Two tables:
 *   - `social_accounts`: connected provider accounts (Twitter, LinkedIn,
 *     Instagram, etc.). Credentials are stored as opaque JSON; secrets
 *     should be persisted via the secrets vault and referenced by id.
 *   - `social_scheduled_posts`: queued posts. The scheduler service fires
 *     a `social.post` tool action when each one is due.
 */

import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export type SocialProvider =
  | "twitter"
  | "linkedin"
  | "instagram"
  | "facebook";

export interface SocialAccountCredentials {
  /** Free-form per-provider auth blob. Real secrets live in the vault. */
  vaultSecretId?: string;
  /** Public display info shown in the UI. */
  handle?: string;
  displayName?: string;
  avatarUrl?: string;
  /** OAuth scopes granted. */
  scopes?: string[];
  /** Token expiry (ms epoch); null = no expiry / refresh-managed. */
  expiresAt?: number | null;
}

export interface SocialPostPayload {
  text: string;
  /** Local paths or remote URLs of media to attach. */
  mediaUrls?: string[];
  /** Provider-specific extras (alt text, link card, etc.). */
  extras?: Record<string, unknown>;
}

export const socialAccounts = sqliteTable("social_accounts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  provider: text("provider").$type<SocialProvider>().notNull(),
  /** Provider-side user id (handle, URN, etc.) for de-duplication. */
  externalId: text("external_id").notNull(),
  /** Human-readable name shown in pickers. */
  label: text("label").notNull(),
  credentialsJson: text("credentials_json", { mode: "json" })
    .$type<SocialAccountCredentials | null>(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

export const socialScheduledPosts = sqliteTable("social_scheduled_posts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  accountId: integer("account_id").notNull(),
  scheduleId: text("schedule_id"),
  /** Post payload JSON. */
  payloadJson: text("payload_json", { mode: "json" })
    .$type<SocialPostPayload>()
    .notNull(),
  /** Unix-ms timestamp the post is due. */
  scheduledFor: integer("scheduled_for").notNull(),
  /** Lifecycle status. */
  status: text("status", {
    enum: ["pending", "posted", "failed", "cancelled"],
  })
    .notNull()
    .default("pending"),
  /** Provider-returned post id (URL or URN) on success. */
  externalPostId: text("external_post_id"),
  /** Error message on failure. */
  errorMessage: text("error_message"),
  postedAt: integer("posted_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

export type SocialAccountRow = typeof socialAccounts.$inferSelect;
export type SocialAccountInsert = typeof socialAccounts.$inferInsert;
export type SocialScheduledPostRow = typeof socialScheduledPosts.$inferSelect;
export type SocialScheduledPostInsert = typeof socialScheduledPosts.$inferInsert;
