/**
 * Engagement inbox synchronisation + reply sending.
 *
 * `syncEngagementsForAccount` pulls inbound comments / mentions / DMs from a
 * provider adapter and upserts them into `social_engagements`, de-duplicating
 * by `(accountId, externalId)`. `sendReply` pushes a drafted reply back out
 * through the adapter and records the result.
 */

import { and, desc, eq } from "drizzle-orm";
import log from "electron-log";

import { db } from "@/db";
import {
  type SocialAccountRow,
  type SocialEngagementReplyRow,
  socialAccounts,
  socialEngagementReplies,
  socialEngagements,
} from "@/db/social_schema";

import { notifySocial } from "./notify";
import { getSocialAdapter } from "./registry";

const logger = log.scope("social:engagement");

async function loadAccount(accountId: number): Promise<SocialAccountRow> {
  const [row] = await db
    .select()
    .from(socialAccounts)
    .where(eq(socialAccounts.id, accountId))
    .limit(1);
  if (!row) throw new Error(`Account ${accountId} not found.`);
  return row;
}

/** Pull new engagements for one account. Returns the number inserted. */
export async function syncEngagementsForAccount(
  accountId: number,
  opts?: { limit?: number; notify?: boolean },
): Promise<number> {
  const account = await loadAccount(accountId);
  const adapter = getSocialAdapter(account.provider);
  if (!adapter.capabilities.canReadEngagements || !adapter.fetchEngagements) {
    return 0;
  }

  const [latest] = await db
    .select({ receivedAt: socialEngagements.receivedAt })
    .from(socialEngagements)
    .where(eq(socialEngagements.accountId, accountId))
    .orderBy(desc(socialEngagements.receivedAt))
    .limit(1);

  const items = await adapter.fetchEngagements(account.credentialsJson ?? {}, {
    sinceMs: latest?.receivedAt,
    limit: opts?.limit ?? 50,
  });

  let inserted = 0;
  for (const item of items) {
    const [exists] = await db
      .select({ id: socialEngagements.id })
      .from(socialEngagements)
      .where(
        and(
          eq(socialEngagements.accountId, accountId),
          eq(socialEngagements.externalId, item.externalId),
        ),
      )
      .limit(1);
    if (exists) continue;

    const now = new Date();
    await db.insert(socialEngagements).values({
      accountId,
      type: item.type,
      externalId: item.externalId,
      externalParentId: item.externalParentId ?? null,
      authorHandle: item.authorHandle ?? null,
      authorDisplayName: item.authorDisplayName ?? null,
      text: item.text,
      permalink: item.permalink ?? null,
      status: "new",
      raw: item.raw ?? null,
      receivedAt: item.receivedAt,
      createdAt: now,
      updatedAt: now,
    });
    inserted++;
  }

  if (inserted > 0 && opts?.notify !== false) {
    await notifySocial({
      title: `${inserted} new ${account.provider} engagement${inserted > 1 ? "s" : ""}`,
      body: `On account ${account.label}.`,
      priority: "medium",
      actionUrl: "/social?tab=inbox",
      actionLabel: "Open inbox",
    });
  }
  return inserted;
}

/** Sync engagements across every enabled, capable account. */
export async function syncAllEngagements(): Promise<{
  total: number;
  perAccount: Record<number, number>;
}> {
  const accounts = await db
    .select()
    .from(socialAccounts)
    .where(eq(socialAccounts.enabled, true));
  let total = 0;
  const perAccount: Record<number, number> = {};
  for (const account of accounts) {
    const adapter = getSocialAdapter(account.provider);
    if (!adapter.capabilities.canReadEngagements) continue;
    try {
      const n = await syncEngagementsForAccount(account.id, { notify: false });
      perAccount[account.id] = n;
      total += n;
    } catch (err) {
      logger.warn(`engagement sync failed for account ${account.id}: ${err}`);
    }
  }
  if (total > 0) {
    await notifySocial({
      title: `${total} new engagement${total > 1 ? "s" : ""}`,
      body: "Your social inbox has new activity.",
      priority: "medium",
      actionUrl: "/social?tab=inbox",
      actionLabel: "Open inbox",
    });
  }
  return { total, perAccount };
}

/** Send a drafted reply through the provider and record the outcome. */
export async function sendReply(
  replyId: number,
): Promise<SocialEngagementReplyRow> {
  const [reply] = await db
    .select()
    .from(socialEngagementReplies)
    .where(eq(socialEngagementReplies.id, replyId))
    .limit(1);
  if (!reply) throw new Error(`Reply ${replyId} not found.`);
  if (reply.status === "sent") throw new Error(`Reply ${replyId} already sent.`);

  const [engagement] = await db
    .select()
    .from(socialEngagements)
    .where(eq(socialEngagements.id, reply.engagementId))
    .limit(1);
  if (!engagement) {
    throw new Error(`Engagement ${reply.engagementId} not found.`);
  }

  const account = await loadAccount(engagement.accountId);
  const adapter = getSocialAdapter(account.provider);
  if (!adapter.capabilities.canReply || !adapter.reply) {
    throw new Error(`${account.provider} does not support replies.`);
  }

  await db
    .update(socialEngagementReplies)
    .set({ status: "sending", updatedAt: new Date() })
    .where(eq(socialEngagementReplies.id, replyId));

  try {
    const res = await adapter.reply(
      account.credentialsJson ?? {},
      {
        externalId: engagement.externalId,
        externalParentId: engagement.externalParentId ?? undefined,
      },
      reply.text,
    );
    const now = new Date();
    const [row] = await db
      .update(socialEngagementReplies)
      .set({
        status: "sent",
        externalReplyId: res.externalReplyId,
        errorMessage: null,
        sentAt: now,
        updatedAt: now,
      })
      .where(eq(socialEngagementReplies.id, replyId))
      .returning();
    await db
      .update(socialEngagements)
      .set({ status: "replied", updatedAt: now })
      .where(eq(socialEngagements.id, engagement.id));
    return row;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await db
      .update(socialEngagementReplies)
      .set({ status: "failed", errorMessage: msg, updatedAt: new Date() })
      .where(eq(socialEngagementReplies.id, replyId));
    throw new Error(`Reply failed: ${msg}`);
  }
}
