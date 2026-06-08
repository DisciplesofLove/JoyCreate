/**
 * Social accounts + posts handlers.
 *
 * Channels:
 *   social:list-providers      provider catalogue (capabilities + readiness)
 *   social:list-accounts       connected accounts
 *   social:get-account         single account
 *   social:update-account      toggle enabled / auto-reply / rename
 *   social:disconnect-account  remove an account + its stored tokens
 *   social:list-posts          posts (optionally filtered) with targets
 *   social:get-post            single post with targets
 *   social:create-post         create a draft / scheduled post
 *   social:update-post         edit a non-posted post
 *   social:delete-post         delete a post + targets
 *   social:publish-post        publish now (fan-out)
 *   social:schedule-post       schedule for later
 *   social:approve-post        approve (schedule or publish)
 *   social:reject-post         cancel a post
 *
 * Handlers throw on error; the renderer surfaces failures via TanStack Query.
 */

import { type SQL, and, desc, eq, inArray } from "drizzle-orm";
import log from "electron-log";

import { deleteTokens } from "@/lib/social/credentials";
import {
  type PublishResult,
  cancelSchedule,
  createPost,
  publishPost,
  schedulePost,
} from "@/lib/social/publisher";
import {
  type SocialProviderInfo,
  listProviderInfo,
} from "@/lib/social/registry";
import { db } from "../../db";
import {
  type SocialAccountCredentials,
  type SocialAccountRow,
  type SocialPostContent,
  type SocialPostRow,
  type SocialPostTargetRow,
  type SocialProvider,
  socialAccounts,
  socialPostTargets,
  socialPosts,
} from "../../db/social_schema";
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
  autoReply: boolean;
  tokenStatus: SocialAccountRow["tokenStatus"];
  expiresAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface SocialPostTargetDto {
  id: number;
  accountId: number;
  provider: SocialProvider | null;
  status: SocialPostTargetRow["status"];
  externalPostId: string | null;
  permalink: string | null;
  errorMessage: string | null;
  postedAt: number | null;
}

export interface SocialPostDto {
  id: number;
  campaignId: number | null;
  content: SocialPostContent;
  status: SocialPostRow["status"];
  source: SocialPostRow["source"];
  scheduledFor: number | null;
  approvedAt: number | null;
  aiModel: string | null;
  aiPrompt: string | null;
  errorMessage: string | null;
  postedAt: number | null;
  createdAt: number;
  updatedAt: number;
  targets: SocialPostTargetDto[];
}

export function toAccountDto(row: SocialAccountRow): SocialAccountDto {
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
    autoReply: row.autoReply,
    tokenStatus: row.tokenStatus,
    expiresAt: creds.expiresAt ?? null,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

function toTargetDto(
  row: SocialPostTargetRow,
  providerByAccount: Map<number, SocialProvider>,
): SocialPostTargetDto {
  return {
    id: row.id,
    accountId: row.accountId,
    provider: providerByAccount.get(row.accountId) ?? null,
    status: row.status,
    externalPostId: row.externalPostId,
    permalink: row.permalink,
    errorMessage: row.errorMessage,
    postedAt: row.postedAt ? row.postedAt.getTime() : null,
  };
}

function toPostDto(
  row: SocialPostRow,
  targets: SocialPostTargetRow[],
  providerByAccount: Map<number, SocialProvider>,
): SocialPostDto {
  return {
    id: row.id,
    campaignId: row.campaignId,
    content: row.contentJson as SocialPostContent,
    status: row.status,
    source: row.source,
    scheduledFor: row.scheduledFor,
    approvedAt: row.approvedAt ? row.approvedAt.getTime() : null,
    aiModel: row.aiModel,
    aiPrompt: row.aiPrompt,
    errorMessage: row.errorMessage,
    postedAt: row.postedAt ? row.postedAt.getTime() : null,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
    targets: targets.map((t) => toTargetDto(t, providerByAccount)),
  };
}

async function providerMap(): Promise<Map<number, SocialProvider>> {
  const rows = await db
    .select({ id: socialAccounts.id, provider: socialAccounts.provider })
    .from(socialAccounts);
  return new Map(rows.map((r) => [r.id, r.provider]));
}

async function loadPostDto(postId: number): Promise<SocialPostDto> {
  const [post] = await db
    .select()
    .from(socialPosts)
    .where(eq(socialPosts.id, postId))
    .limit(1);
  if (!post) throw new Error(`Post not found: ${postId}`);
  const targets = await db
    .select()
    .from(socialPostTargets)
    .where(eq(socialPostTargets.postId, postId));
  return toPostDto(post, targets, await providerMap());
}

function validateContent(content: unknown): SocialPostContent {
  if (!content || typeof content !== "object") {
    throw new Error("Post content is required.");
  }
  const c = content as Record<string, unknown>;
  if (typeof c.text !== "string" || c.text.trim().length === 0) {
    throw new Error("Post content text is required.");
  }
  return content as SocialPostContent;
}

export function registerSocialHandlers(): void {
  handle(
    "social:list-providers",
    async (): Promise<SocialProviderInfo[]> => {
      return listProviderInfo();
    },
  );

  handle("social:list-accounts", async (): Promise<SocialAccountDto[]> => {
    const rows = await db
      .select()
      .from(socialAccounts)
      .orderBy(desc(socialAccounts.createdAt));
    return rows.map(toAccountDto);
  });

  handle(
    "social:get-account",
    async (_e, args: { accountId: number }): Promise<SocialAccountDto> => {
      const [row] = await db
        .select()
        .from(socialAccounts)
        .where(eq(socialAccounts.id, args.accountId))
        .limit(1);
      if (!row) throw new Error(`Account not found: ${args.accountId}`);
      return toAccountDto(row);
    },
  );

  handle(
    "social:update-account",
    async (
      _e,
      args: {
        accountId: number;
        enabled?: boolean;
        autoReply?: boolean;
        label?: string;
      },
    ): Promise<SocialAccountDto> => {
      if (typeof args?.accountId !== "number") {
        throw new Error("accountId is required.");
      }
      const patch: {
        enabled?: boolean;
        autoReply?: boolean;
        label?: string;
        updatedAt: Date;
      } = { updatedAt: new Date() };
      if (typeof args.enabled === "boolean") patch.enabled = args.enabled;
      if (typeof args.autoReply === "boolean") patch.autoReply = args.autoReply;
      if (typeof args.label === "string" && args.label.trim()) {
        patch.label = args.label.trim();
      }
      const [row] = await db
        .update(socialAccounts)
        .set(patch)
        .where(eq(socialAccounts.id, args.accountId))
        .returning();
      if (!row) throw new Error(`Account not found: ${args.accountId}`);
      return toAccountDto(row);
    },
  );

  handle(
    "social:disconnect-account",
    async (_e, args: { accountId: number }): Promise<{ deleted: number }> => {
      if (typeof args?.accountId !== "number") {
        throw new Error("accountId is required.");
      }
      const [existing] = await db
        .select()
        .from(socialAccounts)
        .where(eq(socialAccounts.id, args.accountId))
        .limit(1);
      if (existing) {
        const creds = existing.credentialsJson as SocialAccountCredentials | null;
        if (creds?.vaultSecretId) {
          try {
            deleteTokens(creds.vaultSecretId);
          } catch (err) {
            logger.warn(`failed to delete tokens: ${err}`);
          }
        }
      }
      const r = await db
        .delete(socialAccounts)
        .where(eq(socialAccounts.id, args.accountId))
        .returning({ id: socialAccounts.id });
      return { deleted: r.length };
    },
  );

  // ── Posts ──────────────────────────────────────────────────────────────

  handle(
    "social:list-posts",
    async (
      _e,
      args?: {
        status?: SocialPostRow["status"] | SocialPostRow["status"][];
        campaignId?: number;
        limit?: number;
      },
    ): Promise<SocialPostDto[]> => {
      const conditions: SQL[] = [];
      if (args?.status) {
        const statuses = Array.isArray(args.status)
          ? args.status
          : [args.status];
        if (statuses.length > 0) {
          conditions.push(inArray(socialPosts.status, statuses));
        }
      }
      if (typeof args?.campaignId === "number") {
        conditions.push(eq(socialPosts.campaignId, args.campaignId));
      }
      const where =
        conditions.length === 0
          ? undefined
          : conditions.length === 1
            ? conditions[0]
            : and(...conditions);
      const base = db
        .select()
        .from(socialPosts)
        .orderBy(desc(socialPosts.createdAt))
        .limit(Math.min(Math.max(args?.limit ?? 200, 1), 500));
      const posts = where ? await base.where(where) : await base;
      if (posts.length === 0) return [];

      const postIds = posts.map((p) => p.id);
      const targets = await db
        .select()
        .from(socialPostTargets)
        .where(inArray(socialPostTargets.postId, postIds));
      const map = await providerMap();
      const byPost = new Map<number, SocialPostTargetRow[]>();
      for (const t of targets) {
        const list = byPost.get(t.postId) ?? [];
        list.push(t);
        byPost.set(t.postId, list);
      }
      return posts.map((p) => toPostDto(p, byPost.get(p.id) ?? [], map));
    },
  );

  handle(
    "social:get-post",
    async (_e, args: { postId: number }): Promise<SocialPostDto> => {
      if (typeof args?.postId !== "number") {
        throw new Error("postId is required.");
      }
      return loadPostDto(args.postId);
    },
  );

  handle(
    "social:create-post",
    async (
      _e,
      input: {
        content: SocialPostContent;
        accountIds: number[];
        scheduledFor?: number | null;
        campaignId?: number | null;
        source?: SocialPostRow["source"];
        status?: SocialPostRow["status"];
      },
    ): Promise<SocialPostDto> => {
      const content = validateContent(input?.content);
      if (!Array.isArray(input.accountIds) || input.accountIds.length === 0) {
        throw new Error("At least one target account is required.");
      }
      const { post } = await createPost({
        content,
        accountIds: input.accountIds,
        status: input.status ?? "draft",
        source: input.source ?? "manual",
        campaignId: input.campaignId ?? null,
        scheduledFor: input.scheduledFor ?? null,
      });
      if (
        typeof input.scheduledFor === "number" &&
        input.scheduledFor > Date.now()
      ) {
        await schedulePost(post.id, input.scheduledFor);
      }
      return loadPostDto(post.id);
    },
  );

  handle(
    "social:update-post",
    async (
      _e,
      input: {
        postId: number;
        content?: SocialPostContent;
        scheduledFor?: number | null;
      },
    ): Promise<SocialPostDto> => {
      if (typeof input?.postId !== "number") {
        throw new Error("postId is required.");
      }
      const [existing] = await db
        .select()
        .from(socialPosts)
        .where(eq(socialPosts.id, input.postId))
        .limit(1);
      if (!existing) throw new Error(`Post not found: ${input.postId}`);
      if (
        existing.status === "publishing" ||
        existing.status === "posted" ||
        existing.status === "partially_posted"
      ) {
        throw new Error(`Cannot edit a ${existing.status} post.`);
      }
      const patch: {
        contentJson?: SocialPostContent;
        scheduledFor?: number | null;
        updatedAt: Date;
      } = { updatedAt: new Date() };
      if (input.content !== undefined) {
        patch.contentJson = validateContent(input.content);
      }
      if (input.scheduledFor !== undefined) {
        patch.scheduledFor = input.scheduledFor;
      }
      await db
        .update(socialPosts)
        .set(patch)
        .where(eq(socialPosts.id, input.postId));
      if (
        input.scheduledFor !== undefined &&
        input.scheduledFor !== null &&
        input.scheduledFor > Date.now() &&
        existing.status === "scheduled"
      ) {
        await schedulePost(input.postId, input.scheduledFor);
      }
      return loadPostDto(input.postId);
    },
  );

  handle(
    "social:delete-post",
    async (_e, args: { postId: number }): Promise<{ deleted: number }> => {
      if (typeof args?.postId !== "number") {
        throw new Error("postId is required.");
      }
      const [existing] = await db
        .select()
        .from(socialPosts)
        .where(eq(socialPosts.id, args.postId))
        .limit(1);
      if (existing?.scheduleId) cancelSchedule(existing.scheduleId);
      await db
        .delete(socialPostTargets)
        .where(eq(socialPostTargets.postId, args.postId));
      const r = await db
        .delete(socialPosts)
        .where(eq(socialPosts.id, args.postId))
        .returning({ id: socialPosts.id });
      return { deleted: r.length };
    },
  );

  handle(
    "social:publish-post",
    async (_e, args: { postId: number }): Promise<PublishResult> => {
      if (typeof args?.postId !== "number") {
        throw new Error("postId is required.");
      }
      return publishPost(args.postId);
    },
  );

  handle(
    "social:schedule-post",
    async (
      _e,
      args: { postId: number; scheduledFor: number },
    ): Promise<SocialPostDto> => {
      if (typeof args?.postId !== "number") {
        throw new Error("postId is required.");
      }
      await schedulePost(args.postId, args.scheduledFor);
      return loadPostDto(args.postId);
    },
  );

  handle(
    "social:approve-post",
    async (_e, args: { postId: number }): Promise<SocialPostDto> => {
      if (typeof args?.postId !== "number") {
        throw new Error("postId is required.");
      }
      const [post] = await db
        .select()
        .from(socialPosts)
        .where(eq(socialPosts.id, args.postId))
        .limit(1);
      if (!post) throw new Error(`Post not found: ${args.postId}`);
      await db
        .update(socialPosts)
        .set({
          approvedAt: new Date(),
          approvedBy: "user",
          updatedAt: new Date(),
        })
        .where(eq(socialPosts.id, args.postId));
      if (
        typeof post.scheduledFor === "number" &&
        post.scheduledFor > Date.now()
      ) {
        await schedulePost(args.postId, post.scheduledFor);
      } else {
        await publishPost(args.postId);
      }
      return loadPostDto(args.postId);
    },
  );

  handle(
    "social:reject-post",
    async (_e, args: { postId: number }): Promise<SocialPostDto> => {
      if (typeof args?.postId !== "number") {
        throw new Error("postId is required.");
      }
      const [post] = await db
        .select()
        .from(socialPosts)
        .where(eq(socialPosts.id, args.postId))
        .limit(1);
      if (!post) throw new Error(`Post not found: ${args.postId}`);
      cancelSchedule(post.scheduleId);
      await db
        .update(socialPosts)
        .set({ status: "cancelled", scheduleId: null, updatedAt: new Date() })
        .where(eq(socialPosts.id, args.postId));
      return loadPostDto(args.postId);
    },
  );
}
