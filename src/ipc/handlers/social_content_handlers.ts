/**
 * Social content handlers — AI generation + campaigns.
 *
 * Channels:
 *   social:generate-drafts        topic(s) → on-brand post drafts
 *   social:parse-setup            free text → structured campaign config
 *   social:plan-calendar          cadence → concrete future post slots
 *   social:generate-image         prompt → image file (BYOK image providers)
 *   social:list-campaigns         all campaigns
 *   social:get-campaign           single campaign
 *   social:create-campaign        create a campaign (+ generation schedule)
 *   social:update-campaign        update a campaign (+ resync schedule)
 *   social:delete-campaign        delete a campaign (+ remove schedule)
 *   social:campaign-generate-now  generate drafts for a campaign immediately
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { desc, eq } from "drizzle-orm";
import log from "electron-log";

import {
  type GeneratedDraft,
  type ParsedCampaignSetup,
  type PlannedSlot,
  generatePostDrafts,
  parseNaturalLanguageSetup,
  planCampaignCalendar,
} from "@/lib/social/content_engine";
import { listSupportedProviders } from "@/lib/social/registry";
import {
  generateForCampaign,
  syncCampaignSchedule,
} from "@/lib/social/social_agent";
import { db } from "../../db";
import {
  type SocialCampaignCadence,
  type SocialCampaignRow,
  type SocialCampaignStatus,
  type SocialProvider,
  socialCampaigns,
} from "../../db/social_schema";
import { generateImage } from "./image_studio_handlers";
import { createLoggedHandler } from "./safe_handle";

const logger = log.scope("social:content");
const handle = createLoggedHandler(logger);

export interface SocialCampaignDto {
  id: number;
  name: string;
  description: string | null;
  status: SocialCampaignStatus;
  topics: string[];
  tone: string | null;
  audience: string | null;
  cadence: SocialCampaignCadence | null;
  targetAccountIds: number[];
  autoGenerate: boolean;
  autoPublish: boolean;
  startAt: number | null;
  endAt: number | null;
  createdAt: number;
  updatedAt: number;
}

function toCampaignDto(row: SocialCampaignRow): SocialCampaignDto {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    status: row.status,
    topics: (row.topicsJson as string[] | null) ?? [],
    tone: row.tone,
    audience: row.audience,
    cadence: row.cadenceJson as SocialCampaignCadence | null,
    targetAccountIds: (row.targetAccountIdsJson as number[] | null) ?? [],
    autoGenerate: row.autoGenerate,
    autoPublish: row.autoPublish,
    startAt: row.startAt,
    endAt: row.endAt,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

function mimeForExt(ext: string): string {
  switch (ext.toLowerCase()) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    default:
      return "application/octet-stream";
  }
}

async function loadCampaign(id: number): Promise<SocialCampaignRow> {
  const [row] = await db
    .select()
    .from(socialCampaigns)
    .where(eq(socialCampaigns.id, id))
    .limit(1);
  if (!row) throw new Error(`Campaign not found: ${id}`);
  return row;
}

export function registerSocialContentHandlers(): void {
  handle(
    "social:generate-drafts",
    async (
      _e,
      input: {
        topics: string[];
        provider?: SocialProvider;
        tone?: string;
        audience?: string;
        brandVoice?: string;
        count?: number;
        includeImagePrompt?: boolean;
      },
    ): Promise<GeneratedDraft[]> => {
      if (!input?.topics || input.topics.length === 0) {
        throw new Error("At least one topic is required.");
      }
      return generatePostDrafts({
        topics: input.topics,
        provider: input.provider,
        tone: input.tone,
        audience: input.audience,
        brandVoice: input.brandVoice,
        count: input.count,
        includeImagePrompt: input.includeImagePrompt,
      });
    },
  );

  handle(
    "social:parse-setup",
    async (
      _e,
      input: { instruction: string },
    ): Promise<ParsedCampaignSetup> => {
      if (!input?.instruction?.trim()) {
        throw new Error("An instruction is required.");
      }
      return parseNaturalLanguageSetup(input.instruction, {
        availableProviders: listSupportedProviders(),
      });
    },
  );

  handle(
    "social:plan-calendar",
    async (
      _e,
      input: {
        campaignId?: number;
        cadence?: SocialCampaignCadence;
        topics?: string[];
        count?: number;
        fromMs?: number;
      },
    ): Promise<PlannedSlot[]> => {
      let cadence = input.cadence;
      let topics = input.topics ?? [];
      if (typeof input.campaignId === "number") {
        const campaign = await loadCampaign(input.campaignId);
        cadence =
          (campaign.cadenceJson as SocialCampaignCadence | null) ?? undefined;
        topics = (campaign.topicsJson as string[] | null) ?? [];
      }
      if (!cadence) {
        throw new Error("A cadence (or a campaignId) is required.");
      }
      return planCampaignCalendar({
        cadence,
        fromMs: input.fromMs ?? Date.now(),
        count: Math.min(Math.max(input.count ?? 10, 1), 60),
        topics,
      });
    },
  );

  handle(
    "social:generate-image",
    async (
      _e,
      input: {
        prompt: string;
        provider: string;
        model: string;
        width?: number;
        height?: number;
        negativePrompt?: string;
        style?: string;
      },
    ): Promise<{ filePath: string; dataUrl: string }> => {
      if (!input?.prompt?.trim()) throw new Error("An image prompt is required.");
      if (!input.provider) throw new Error("An image provider is required.");
      if (!input.model) throw new Error("An image model is required.");
      const filePath = await generateImage({
        provider: input.provider,
        model: input.model,
        prompt: input.prompt,
        negativePrompt: input.negativePrompt,
        width: input.width ?? 1024,
        height: input.height ?? 1024,
        style: input.style,
      });
      const buf = await fs.promises.readFile(filePath);
      const dataUrl = `data:${mimeForExt(path.extname(filePath))};base64,${buf.toString("base64")}`;
      return { filePath, dataUrl };
    },
  );

  // ── Campaigns ──────────────────────────────────────────────────────────

  handle("social:list-campaigns", async (): Promise<SocialCampaignDto[]> => {
    const rows = await db
      .select()
      .from(socialCampaigns)
      .orderBy(desc(socialCampaigns.createdAt));
    return rows.map(toCampaignDto);
  });

  handle(
    "social:get-campaign",
    async (_e, args: { campaignId: number }): Promise<SocialCampaignDto> => {
      return toCampaignDto(await loadCampaign(args.campaignId));
    },
  );

  handle(
    "social:create-campaign",
    async (
      _e,
      input: {
        name: string;
        description?: string;
        topics: string[];
        tone?: string;
        audience?: string;
        cadence?: SocialCampaignCadence;
        targetAccountIds: number[];
        autoGenerate?: boolean;
        autoPublish?: boolean;
        status?: SocialCampaignStatus;
      },
    ): Promise<SocialCampaignDto> => {
      if (!input?.name?.trim()) throw new Error("A campaign name is required.");
      if (!Array.isArray(input.topics) || input.topics.length === 0) {
        throw new Error("At least one topic is required.");
      }
      const now = new Date();
      const [row] = await db
        .insert(socialCampaigns)
        .values({
          name: input.name.trim(),
          description: input.description ?? null,
          status: input.status ?? "active",
          topicsJson: input.topics,
          tone: input.tone ?? null,
          audience: input.audience ?? null,
          cadenceJson: input.cadence ?? null,
          targetAccountIdsJson: input.targetAccountIds ?? [],
          autoGenerate: input.autoGenerate ?? false,
          autoPublish: input.autoPublish ?? false,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      if (!row) throw new Error("Failed to create campaign.");
      await syncCampaignSchedule(row.id);
      return toCampaignDto(await loadCampaign(row.id));
    },
  );

  handle(
    "social:update-campaign",
    async (
      _e,
      input: {
        campaignId: number;
        name?: string;
        description?: string | null;
        topics?: string[];
        tone?: string | null;
        audience?: string | null;
        cadence?: SocialCampaignCadence | null;
        targetAccountIds?: number[];
        autoGenerate?: boolean;
        autoPublish?: boolean;
        status?: SocialCampaignStatus;
      },
    ): Promise<SocialCampaignDto> => {
      if (typeof input?.campaignId !== "number") {
        throw new Error("campaignId is required.");
      }
      await loadCampaign(input.campaignId);
      const patch: Partial<SocialCampaignRow> & { updatedAt: Date } = {
        updatedAt: new Date(),
      };
      if (input.name !== undefined) patch.name = input.name.trim();
      if (input.description !== undefined) patch.description = input.description;
      if (input.topics !== undefined) patch.topicsJson = input.topics;
      if (input.tone !== undefined) patch.tone = input.tone;
      if (input.audience !== undefined) patch.audience = input.audience;
      if (input.cadence !== undefined) patch.cadenceJson = input.cadence;
      if (input.targetAccountIds !== undefined) {
        patch.targetAccountIdsJson = input.targetAccountIds;
      }
      if (input.autoGenerate !== undefined) {
        patch.autoGenerate = input.autoGenerate;
      }
      if (input.autoPublish !== undefined) patch.autoPublish = input.autoPublish;
      if (input.status !== undefined) patch.status = input.status;

      await db
        .update(socialCampaigns)
        .set(patch)
        .where(eq(socialCampaigns.id, input.campaignId));
      await syncCampaignSchedule(input.campaignId);
      return toCampaignDto(await loadCampaign(input.campaignId));
    },
  );

  handle(
    "social:delete-campaign",
    async (_e, args: { campaignId: number }): Promise<{ deleted: number }> => {
      if (typeof args?.campaignId !== "number") {
        throw new Error("campaignId is required.");
      }
      const [existing] = await db
        .select()
        .from(socialCampaigns)
        .where(eq(socialCampaigns.id, args.campaignId))
        .limit(1);
      if (existing) {
        // Setting status away from active + removing schedule.
        await db
          .update(socialCampaigns)
          .set({ status: "archived", autoGenerate: false, updatedAt: new Date() })
          .where(eq(socialCampaigns.id, args.campaignId));
        await syncCampaignSchedule(args.campaignId);
      }
      const r = await db
        .delete(socialCampaigns)
        .where(eq(socialCampaigns.id, args.campaignId))
        .returning({ id: socialCampaigns.id });
      return { deleted: r.length };
    },
  );

  handle(
    "social:campaign-generate-now",
    async (
      _e,
      args: { campaignId: number; count?: number },
    ): Promise<{ created: number; postIds: number[] }> => {
      if (typeof args?.campaignId !== "number") {
        throw new Error("campaignId is required.");
      }
      return generateForCampaign(args.campaignId, { count: args.count });
    },
  );
}
