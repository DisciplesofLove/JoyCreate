/**
 * Social posting handlers.
 *
 * Channels:
 *   social:list-accounts
 *   social:connect-account
 *   social:disconnect-account
 *   social:post                  (immediate)
 *   social:schedule-post
 *   social:list-scheduled
 *   social:cancel-scheduled
 *
 * Scheduled posts piggy-back on `SchedulerService` via a one-shot cron
 * computed from `scheduledFor`. The fired tool action is `social.post`
 * with `{ scheduledPostId }`, dispatched through the existing tools
 * runtime once a matching tool is registered.
 */

import log from "electron-log";
import { and, asc, eq, gte } from "drizzle-orm";

import { db } from "../../db";
import {
  socialAccounts,
  socialScheduledPosts,
  type SocialAccountCredentials,
  type SocialAccountRow,
  type SocialPostPayload,
  type SocialProvider,
  type SocialScheduledPostRow,
} from "../../db/social_schema";
import { getSocialAdapter, listSupportedProviders } from "@/lib/social/registry";
import { getSchedulerService } from "@/lib/scheduler_service";
import { createLoggedHandler } from "./safe_handle";

const logger = log.scope("social");
const handle = createLoggedHandler(logger);

export interface SocialAccountDto {
  id: number;
  provider: SocialProvider;
  externalId: string;
  label: string;
  handle: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  enabled: boolean;
  expiresAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface SocialScheduledPostDto {
  id: number;
  accountId: number;
  payload: SocialPostPayload;
  scheduledFor: number;
  status: SocialScheduledPostRow["status"];
  externalPostId: string | null;
  errorMessage: string | null;
  postedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

function toAccountDto(row: SocialAccountRow): SocialAccountDto {
  const creds = (row.credentialsJson as SocialAccountCredentials | null) ?? {};
  return {
    id: row.id,
    provider: row.provider,
    externalId: row.externalId,
    label: row.label,
    handle: creds.handle ?? null,
    displayName: creds.displayName ?? null,
    avatarUrl: creds.avatarUrl ?? null,
    enabled: row.enabled,
    expiresAt: creds.expiresAt ?? null,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

function toScheduledDto(row: SocialScheduledPostRow): SocialScheduledPostDto {
  return {
    id: row.id,
    accountId: row.accountId,
    payload: row.payloadJson as SocialPostPayload,
    scheduledFor: row.scheduledFor,
    status: row.status,
    externalPostId: row.externalPostId,
    errorMessage: row.errorMessage,
    postedAt: row.postedAt ? row.postedAt.getTime() : null,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

function validatePayload(payload: unknown): SocialPostPayload {
  if (!payload || typeof payload !== "object") {
    throw new Error("social: payload required");
  }
  const p = payload as Record<string, unknown>;
  if (typeof p.text !== "string" || p.text.trim().length === 0) {
    throw new Error("social: payload.text required");
  }
  if (p.mediaUrls !== undefined && !Array.isArray(p.mediaUrls)) {
    throw new Error("social: payload.mediaUrls must be an array");
  }
  return {
    text: p.text,
    mediaUrls: (p.mediaUrls as string[] | undefined) ?? [],
    extras: (p.extras as Record<string, unknown> | undefined) ?? {},
  };
}

function isSocialProvider(value: unknown): value is SocialProvider {
  return (
    typeof value === "string" &&
    (value === "twitter" ||
      value === "linkedin" ||
      value === "instagram" ||
      value === "facebook")
  );
}

async function loadAccount(accountId: number): Promise<SocialAccountRow> {
  const [row] = await db
    .select()
    .from(socialAccounts)
    .where(eq(socialAccounts.id, accountId))
    .limit(1);
  if (!row) throw new Error(`social: account ${accountId} not found`);
  if (!row.enabled) throw new Error(`social: account ${accountId} is disabled`);
  return row;
}

/** Convert a unix-ms timestamp into a one-shot 5-field cron expression. */
function timestampToCron(ms: number): string {
  const d = new Date(ms);
  d.setSeconds(0, 0);
  // Cron month is 1-12, JS month is 0-11.
  return `${d.getMinutes()} ${d.getHours()} ${d.getDate()} ${d.getMonth() + 1} *`;
}

export function registerSocialHandlers(): void {
  handle("social:list-providers", async (): Promise<SocialProvider[]> => {
    return listSupportedProviders();
  });

  handle("social:list-accounts", async (): Promise<SocialAccountDto[]> => {
    const rows = await db.select().from(socialAccounts);
    return rows.map(toAccountDto);
  });

  handle(
    "social:connect-account",
    async (
      _e,
      input: {
        provider: SocialProvider;
        authCode?: string;
        extras?: Record<string, unknown>;
      },
    ): Promise<SocialAccountDto> => {
      if (!input || !isSocialProvider(input.provider)) {
        throw new Error("social: provider is required");
      }
      const adapter = getSocialAdapter(input.provider);
      const { externalId, label, credentials } = await adapter.connect({
        authCode: input.authCode,
        extras: input.extras,
      });

      // Upsert on (provider, externalId) — keep the prior row id when it exists.
      const [existing] = await db
        .select()
        .from(socialAccounts)
        .where(
          and(
            eq(socialAccounts.provider, input.provider),
            eq(socialAccounts.externalId, externalId),
          ),
        )
        .limit(1);

      const now = new Date();
      if (existing) {
        const [row] = await db
          .update(socialAccounts)
          .set({
            label,
            credentialsJson: credentials,
            enabled: true,
            updatedAt: now,
          })
          .where(eq(socialAccounts.id, existing.id))
          .returning();
        return toAccountDto(row);
      }
      const [row] = await db
        .insert(socialAccounts)
        .values({
          provider: input.provider,
          externalId,
          label,
          credentialsJson: credentials,
          enabled: true,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      return toAccountDto(row);
    },
  );

  handle(
    "social:disconnect-account",
    async (_e, args: { accountId: number }): Promise<{ deleted: number }> => {
      if (!args || typeof args.accountId !== "number") {
        throw new Error("social: accountId required");
      }
      const r = await db
        .delete(socialAccounts)
        .where(eq(socialAccounts.id, args.accountId))
        .returning({ id: socialAccounts.id });
      return { deleted: r.length };
    },
  );

  handle(
    "social:post",
    async (
      _e,
      input: { accountId: number; payload: SocialPostPayload },
    ): Promise<{ externalPostId: string; permalink?: string }> => {
      if (!input || typeof input.accountId !== "number") {
        throw new Error("social: accountId required");
      }
      const payload = validatePayload(input.payload);
      const account = await loadAccount(input.accountId);
      const adapter = getSocialAdapter(account.provider);
      const result = await adapter.post(
        (account.credentialsJson as SocialAccountCredentials) ?? {},
        payload,
      );
      return { externalPostId: result.externalPostId, permalink: result.permalink };
    },
  );

  handle(
    "social:schedule-post",
    async (
      _e,
      input: {
        accountId: number;
        payload: SocialPostPayload;
        scheduledFor: number;
      },
    ): Promise<SocialScheduledPostDto> => {
      if (!input || typeof input.accountId !== "number") {
        throw new Error("social: accountId required");
      }
      if (typeof input.scheduledFor !== "number" || input.scheduledFor <= Date.now()) {
        throw new Error("social: scheduledFor must be a future unix-ms timestamp");
      }
      const payload = validatePayload(input.payload);
      const account = await loadAccount(input.accountId);

      const now = new Date();
      const [row] = await db
        .insert(socialScheduledPosts)
        .values({
          accountId: account.id,
          payloadJson: payload,
          scheduledFor: input.scheduledFor,
          status: "pending",
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      if (!row) throw new Error("social: insert returned no row");

      // Register a one-shot cron via the scheduler.
      const scheduler = getSchedulerService();
      const sched = scheduler.create({
        name: `social-post-${row.id}`,
        cron: timestampToCron(input.scheduledFor),
        action: {
          toolName: "social.post",
          args: { scheduledPostId: row.id },
        },
        ownerId: String(account.id),
        ownerKind: "agent",
        enabled: true,
      });
      await db
        .update(socialScheduledPosts)
        .set({ scheduleId: sched.id, updatedAt: new Date() })
        .where(eq(socialScheduledPosts.id, row.id));
      return toScheduledDto({ ...row, scheduleId: sched.id });
    },
  );

  handle(
    "social:list-scheduled",
    async (
      _e,
      args?: { accountId?: number; sinceMs?: number },
    ): Promise<SocialScheduledPostDto[]> => {
      const conditions = [] as any[];
      if (args?.accountId !== undefined) {
        conditions.push(eq(socialScheduledPosts.accountId, args.accountId));
      }
      if (args?.sinceMs !== undefined) {
        conditions.push(gte(socialScheduledPosts.scheduledFor, args.sinceMs));
      }
      const where =
        conditions.length === 0
          ? undefined
          : conditions.length === 1
            ? conditions[0]
            : and(...conditions);
      const q = db
        .select()
        .from(socialScheduledPosts)
        .orderBy(asc(socialScheduledPosts.scheduledFor));
      const rows = where ? await q.where(where) : await q;
      return rows.map(toScheduledDto);
    },
  );

  handle(
    "social:cancel-scheduled",
    async (_e, args: { id: number }): Promise<SocialScheduledPostDto> => {
      if (!args || typeof args.id !== "number") {
        throw new Error("social: id required");
      }
      const [existing] = await db
        .select()
        .from(socialScheduledPosts)
        .where(eq(socialScheduledPosts.id, args.id))
        .limit(1);
      if (!existing) throw new Error(`social: scheduled post ${args.id} not found`);
      if (existing.status !== "pending") {
        throw new Error(`social: scheduled post ${args.id} cannot be cancelled (status=${existing.status})`);
      }
      if (existing.scheduleId) {
        try {
          getSchedulerService().remove(existing.scheduleId as any);
        } catch (err) {
          logger.warn("scheduler remove failed", { id: existing.scheduleId, err });
        }
      }
      const [row] = await db
        .update(socialScheduledPosts)
        .set({ status: "cancelled", updatedAt: new Date() })
        .where(eq(socialScheduledPosts.id, args.id))
        .returning();
      return toScheduledDto(row);
    },
  );
}

/**
 * Tool entry point invoked by the scheduler when a queued post fires.
 * Exported so the tools registry can mount it as `social.post`.
 */
export async function executeScheduledSocialPost(args: {
  scheduledPostId: number;
}): Promise<{ externalPostId: string; permalink?: string }> {
  if (!args || typeof args.scheduledPostId !== "number") {
    throw new Error("social.post: scheduledPostId required");
  }
  const [row] = await db
    .select()
    .from(socialScheduledPosts)
    .where(eq(socialScheduledPosts.id, args.scheduledPostId))
    .limit(1);
  if (!row) throw new Error(`social.post: scheduled post ${args.scheduledPostId} missing`);
  if (row.status !== "pending") {
    throw new Error(`social.post: status is ${row.status}`);
  }
  try {
    const account = await loadAccount(row.accountId);
    const adapter = getSocialAdapter(account.provider);
    const result = await adapter.post(
      (account.credentialsJson as SocialAccountCredentials) ?? {},
      row.payloadJson as SocialPostPayload,
    );
    await db
      .update(socialScheduledPosts)
      .set({
        status: "posted",
        externalPostId: result.externalPostId,
        postedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(socialScheduledPosts.id, row.id));
    return { externalPostId: result.externalPostId, permalink: result.permalink };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db
      .update(socialScheduledPosts)
      .set({
        status: "failed",
        errorMessage: message,
        updatedAt: new Date(),
      })
      .where(eq(socialScheduledPosts.id, row.id));
    throw err;
  }
}
