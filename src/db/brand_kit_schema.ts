/**
 * Brand Kit schema.
 *
 * A brand kit captures a creator's voice, palette, fonts, logo, and copy
 * guardrails so any agent in JoyCreate can produce on-brand output without
 * the user re-describing themselves every time. Inspired by Hyperagent's
 * "Describe your voice once" experience.
 *
 * Scope: per-user-global. Individual agents opt-in via `agents.brandKitId`.
 */

import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export interface BrandColorTokens {
  /** Hex color (e.g. "#7C3AED"). Required. */
  primary: string;
  secondary?: string;
  accent?: string;
  background?: string;
  foreground?: string;
  /** Free-form named tokens, e.g. { "cta-hover": "#5B21B6" }. */
  extras?: Record<string, string>;
}

export interface BrandFontStack {
  display?: string;
  body?: string;
  mono?: string;
}

export const brandKits = sqliteTable("brand_kits", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  description: text("description"),

  /** Path or URL to the logo asset (managed by `brand-kit:upload-asset`). */
  logoUrl: text("logo_url"),
  /** Path or URL to a wordmark / secondary logo. */
  wordmarkUrl: text("wordmark_url"),

  /** Color palette JSON. */
  colorTokens: text("color_tokens", { mode: "json" })
    .$type<BrandColorTokens | null>(),

  /** Markdown voice / tone guide consumed by agent prompt assembly. */
  voiceGuide: text("voice_guide"),

  /** Font families JSON. */
  fontStack: text("font_stack", { mode: "json" })
    .$type<BrandFontStack | null>(),

  /** Hard rules — phrases / topics the agent must avoid. */
  doNotJson: text("do_not_json", { mode: "json" }).$type<string[] | null>(),

  /** Default tagline injected into generated copy. */
  tagline: text("tagline"),

  /** Whether this brand kit is the user's default. */
  isDefault: integer("is_default", { mode: "boolean" })
    .notNull()
    .default(false),

  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

export type BrandKitRow = typeof brandKits.$inferSelect;
export type BrandKitInsert = typeof brandKits.$inferInsert;
