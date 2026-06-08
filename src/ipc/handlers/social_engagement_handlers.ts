/**
 * Social engagement inbox handlers — comments / mentions / DMs + replies.
 *
 * Channels:
 *   social:list-engagements    unified inbox (optionally filtered) with replies
 *   social:sync-engagements    pull fresh engagements from adapters
 *   social:suggest-reply       AI-draft a reply (no persistence)
 *   social:reply               create + send a manual reply
 *   social:approve-reply       send an existing draft / needs-approval reply
 *   social:dismiss-reply       dismiss a drafted reply
 *   social:mark-engagement     change an engagement's status
 */

import { type SQL, and, desc, eq, inArray } from "drizzle-orm";
import log from "electron-log";

import { suggestReply } from "@/lib/social/content_engine";
import {
  sendReply,
  syncAllEngagements,
  syncEngagementsForAccount,
} from "@/lib/social/engagement_sync";
import { getAgentSettings } from "@/lib/social/social_agent";
import { db } from "../../db";
import {
  type SocialAccountRow,
  type SocialEngagementReplyRow,
  type SocialEngagementRow,
  type SocialEngagementStatus,
  type SocialProvider,
  socialAccounts,
  socialEngagementReplies,
  socialEngagements,
} from "../../db/social_schema";
import { createLoggedHandler } from "./safe_handle";

const logger = log.scope("social:engagement");
const handle = createLoggedHandler(logger);

export interface SocialReplyDto {
  id: number;
  engagementId: number;
  text: string;
  status: SocialEngagementReplyRow["status"];
  source: SocialEngagementReplyRow["source"];
  externalReplyId: string | null;
  errorMessage: string | null;
  sentAt: number | null;
  createdAt: number;
}

export interface SocialEngagementDto {
  id: number;
  accountId: number;
  provider: SocialProvider | null;
  type: SocialEngagementRow["type"];
  externalId: string;
  externalParentId: string | null;
  authorHandle: string | null;
  authorDisplayName: string | null;
  text: string;
  permalink: string | null;
  sentiment: SocialEngagementRow["sentiment"];
  status: SocialEngagementRow["status"];
  receivedAt: number;
  createdAt: number;
  replies: SocialReplyDto[];
}

function toReplyDto(row: SocialEngagementReplyRow): SocialReplyDto {
  return {
    id: row.id,
    engagementId: row.engagementId,
    text: row.text,
    status: row.status,
    source: row.source,
    externalReplyId: row.externalReplyId,
    errorMessage: row.errorMessage,
    sentAt: row.sentAt ? row.sentAt.getTime() : null,
    createdAt: row.createdAt.getTime(),
  };
}

function toEngagementDto(
  row: SocialEngagementRow,
  provider: SocialProvider | null,
  replies: SocialReplyDto[],
): SocialEngagementDto {
  return {
    id: row.id,
    accountId: row.accountId,
    provider,
    type: row.type,
    externalId: row.externalId,
    externalParentId: row.externalParentId,
    authorHandle: row.authorHandle,
    authorDisplayName: row.authorDisplayName,
    text: row.text,
    permalink: row.permalink,
    sentiment: row.sentiment,
    status: row.status,
    receivedAt: row.receivedAt,
    createdAt: row.createdAt.getTime(),
    replies,
  };
}

async function loadEngagement(id: number): Promise<SocialEngagementRow> {
  const [row] = await db
    .select()
    .from(socialEngagements)
    .where(eq(socialEngagements.id, id))
    .limit(1);
  if (!row) throw new Error(`Engagement not found: ${id}`);
  return row;
}

async function loadReply(id: number): Promise<SocialEngagementReplyRow> {
  const [row] = await db
    .select()
    .from(socialEngagementReplies)
    .where(eq(socialEngagementReplies.id, id))
    .limit(1);
  if (!row) throw new Error(`Reply not found: ${id}`);
  return row;
}

export function registerSocialEngagementHandlers(): void {
  handle(
    "social:list-engagements",
    async (
      _e,
      input?: {
        status?: SocialEngagementStatus;
        accountId?: number;
        limit?: number;
      },
    ): Promise<SocialEngagementDto[]> => {
      const conditions: SQL[] = [];
      if (input?.status) {
        conditions.push(eq(socialEngagements.status, input.status));
      }
      if (typeof input?.accountId === "number") {
        conditions.push(eq(socialEngagements.accountId, input.accountId));
      }
      const rows = await db
        .select()
        .from(socialEngagements)
        .where(conditions.length ? and(...conditions) : undefined)
        .orderBy(desc(socialEngagements.receivedAt))
        .limit(Math.min(Math.max(input?.limit ?? 100, 1), 500));

      if (rows.length === 0) return [];

      const accountIds = [...new Set(rows.map((r) => r.accountId))];
      const accounts = await db
        .select()
        .from(socialAccounts)
        .where(inArray(socialAccounts.id, accountIds));
      const providerById = new Map<number, SocialProvider>(
        accounts.map((a: SocialAccountRow) => [a.id, a.provider]),
      );

      const engagementIds = rows.map((r) => r.id);
      const replyRows = await db
        .select()
        .from(socialEngagementReplies)
        .where(inArray(socialEngagementReplies.engagementId, engagementIds))
        .orderBy(desc(socialEngagementReplies.createdAt));
      const repliesByEngagement = new Map<number, SocialReplyDto[]>();
      for (const reply of replyRows) {
        const list = repliesByEngagement.get(reply.engagementId) ?? [];
        list.push(toReplyDto(reply));
        repliesByEngagement.set(reply.engagementId, list);
      }

      return rows.map((row) =>
        toEngagementDto(
          row,
          providerById.get(row.accountId) ?? null,
          repliesByEngagement.get(row.id) ?? [],
        ),
      );
    },
  );

  handle(
    "social:sync-engagements",
    async (
      _e,
      input?: { accountId?: number },
    ): Promise<{ inserted: number }> => {
      if (typeof input?.accountId === "number") {
        const inserted = await syncEngagementsForAccount(input.accountId, {
          notify: true,
        });
        return { inserted };
      }
      const { total } = await syncAllEngagements();
      return { inserted: total };
    },
  );

  handle(
    "social:suggest-reply",
    async (
      _e,
      input: { engagementId: number; tone?: string; postContext?: string },
    ): Promise<{ text: string }> => {
      const engagement = await loadEngagement(input.engagementId);
      const settings = await getAgentSettings();
      const text = await suggestReply({
        engagementText: engagement.text,
        authorHandle: engagement.authorHandle ?? undefined,
        postContext: input.postContext,
        tone: input.tone ?? settings.defaultTone ?? undefined,
        brandVoice: settings.brandVoice ?? undefined,
      });
      return { text };
    },
  );

  handle(
    "social:reply",
    async (
      _e,
      input: { engagementId: number; text: string },
    ): Promise<SocialReplyDto> => {
      if (!input?.text?.trim()) throw new Error("Reply text is required.");
      await loadEngagement(input.engagementId);
      const now = new Date();
      const [draft] = await db
        .insert(socialEngagementReplies)
        .values({
          engagementId: input.engagementId,
          text: input.text.trim(),
          status: "draft",
          source: "manual",
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      if (!draft) throw new Error("Failed to create reply.");
      const sent = await sendReply(draft.id);
      return toReplyDto(sent);
    },
  );

  handle(
    "social:approve-reply",
    async (_e, input: { replyId: number }): Promise<SocialReplyDto> => {
      const reply = await loadReply(input.replyId);
      if (reply.status === "sent") return toReplyDto(reply);
      await db
        .update(socialEngagementReplies)
        .set({ approvedAt: new Date(), updatedAt: new Date() })
        .where(eq(socialEngagementReplies.id, input.replyId));
      const sent = await sendReply(input.replyId);
      return toReplyDto(sent);
    },
  );

  handle(
    "social:dismiss-reply",
    async (_e, input: { replyId: number }): Promise<SocialReplyDto> => {
      await loadReply(input.replyId);
      await db
        .update(socialEngagementReplies)
        .set({ status: "dismissed", updatedAt: new Date() })
        .where(eq(socialEngagementReplies.id, input.replyId));
      return toReplyDto(await loadReply(input.replyId));
    },
  );

  handle(
    "social:mark-engagement",
    async (
      _e,
      input: { engagementId: number; status: SocialEngagementStatus },
    ): Promise<SocialEngagementDto> => {
      await loadEngagement(input.engagementId);
      await db
        .update(socialEngagements)
        .set({ status: input.status, updatedAt: new Date() })
        .where(eq(socialEngagements.id, input.engagementId));
      const row = await loadEngagement(input.engagementId);
      const [account] = await db
        .select()
        .from(socialAccounts)
        .where(eq(socialAccounts.id, row.accountId))
        .limit(1);
      const replyRows = await db
        .select()
        .from(socialEngagementReplies)
        .where(eq(socialEngagementReplies.engagementId, row.id))
        .orderBy(desc(socialEngagementReplies.createdAt));
      return toEngagementDto(
        row,
        account?.provider ?? null,
        replyRows.map(toReplyDto),
      );
    },
  );
}
