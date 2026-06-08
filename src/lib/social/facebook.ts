/**
 * Facebook Pages adapter (Graph API v19.0).
 *
 * A connected Facebook "account" is a Page the user administers (personal
 * profile posting is not supported by the Graph API). The flow:
 *   - OAuth2 authorize (`/dialog/oauth`) with Page management scopes
 *   - code → short-lived user token → long-lived user token exchange
 *   - list managed Pages (`/me/accounts`) and bind the first (or `extras.pageId`)
 *   - publish to the Page feed (`POST /{page-id}/feed`)
 *   - read + reply to comments (`/{post-id}/comments`, `/{comment-id}/comments`)
 *   - per-post metrics (likes / comments / shares summaries)
 *
 * Page access tokens derived from a long-lived user token do not expire, so no
 * refresh cycle is required.
 */

import log from "electron-log";

import type {
  SocialAccountCredentials,
  SocialPostPayload,
} from "@/db/social_schema";
import {
  type SocialTokenBundle,
  getAppCredentials,
  loadTokens,
  saveTokens,
} from "./credentials";
import { PendingAuthStore, randomState } from "./oauth_helpers";
import type {
  FetchEngagementsOptions,
  SocialAdapter,
  SocialAdapterCapabilities,
  SocialAuthUrl,
  SocialConnectInput,
  SocialEngagementData,
  SocialMetricsData,
  SocialPostResult,
  SocialReplyResult,
} from "./types";

const logger = log.scope("social:facebook");

const GRAPH_VERSION = "v19.0";
const DIALOG_URL = `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth`;
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;
const SCOPES = [
  "public_profile",
  "pages_show_list",
  "pages_manage_posts",
  "pages_read_engagement",
  "pages_manage_engagement",
];

const pending = new PendingAuthStore();

const CAPABILITIES: SocialAdapterCapabilities = {
  canPublish: true,
  canReadEngagements: true,
  canReply: true,
  canMetrics: true,
  canUploadMedia: false,
  oauth: true,
  maxTextLength: 63206,
  mediaTypes: [],
};

function requireApp() {
  const app = getAppCredentials("facebook");
  if (!app?.clientId || !app.clientSecret) {
    throw new Error(
      "Facebook is not configured. Add your Meta app's id and secret in Settings → Social.",
    );
  }
  return app;
}

async function exchangeCodeForUserToken(
  code: string,
  redirectUri: string,
): Promise<string> {
  const app = requireApp();
  const url = new URL(`${GRAPH_BASE}/oauth/access_token`);
  url.searchParams.set("client_id", app.clientId);
  url.searchParams.set("client_secret", app.clientSecret ?? "");
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("code", code);
  const res = await fetch(url.toString());
  if (!res.ok) {
    throw new Error(
      `Facebook token exchange failed (${res.status}): ${await res
        .text()
        .catch(() => "")}`,
    );
  }
  const json = (await res.json()) as { access_token?: string };
  if (!json.access_token) {
    throw new Error("Facebook token exchange returned no access token.");
  }
  return json.access_token;
}

async function exchangeForLongLivedToken(
  shortLived: string,
): Promise<string> {
  const app = requireApp();
  const url = new URL(`${GRAPH_BASE}/oauth/access_token`);
  url.searchParams.set("grant_type", "fb_exchange_token");
  url.searchParams.set("client_id", app.clientId);
  url.searchParams.set("client_secret", app.clientSecret ?? "");
  url.searchParams.set("fb_exchange_token", shortLived);
  const res = await fetch(url.toString());
  if (!res.ok) {
    // Non-fatal: fall back to the short-lived token.
    logger.warn(`long-lived token exchange failed (${res.status})`);
    return shortLived;
  }
  const json = (await res.json()) as { access_token?: string };
  return json.access_token ?? shortLived;
}

interface ManagedPage {
  id: string;
  name: string;
  access_token: string;
}

async function listManagedPages(userToken: string): Promise<ManagedPage[]> {
  const url = new URL(`${GRAPH_BASE}/me/accounts`);
  url.searchParams.set("fields", "id,name,access_token");
  url.searchParams.set("access_token", userToken);
  const res = await fetch(url.toString());
  if (!res.ok) {
    throw new Error(`Facebook page lookup failed (${res.status}).`);
  }
  const json = (await res.json()) as { data?: ManagedPage[] };
  return json.data ?? [];
}

function pageToken(credentials: SocialAccountCredentials): {
  token: string;
  pageId: string;
} {
  const secretId = credentials.vaultSecretId;
  if (!secretId) {
    throw new Error("Facebook account is missing its stored credentials. Reconnect it.");
  }
  const bundle = loadTokens(secretId);
  if (!bundle) {
    throw new Error("Facebook tokens not found. Reconnect the account.");
  }
  const pageId = credentials.extra?.pageId;
  if (typeof pageId !== "string" || !pageId) {
    throw new Error("Facebook account is missing its page id. Reconnect it.");
  }
  return { token: bundle.accessToken, pageId };
}

export const facebookAdapter: SocialAdapter = {
  provider: "facebook",
  capabilities: CAPABILITIES,

  async getAuthUrl({ redirectUri }): Promise<SocialAuthUrl> {
    const app = requireApp();
    const state = randomState();
    pending.remember(state, { redirectUri });
    const url = new URL(DIALOG_URL);
    url.searchParams.set("client_id", app.clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("scope", SCOPES.join(","));
    url.searchParams.set("response_type", "code");
    url.searchParams.set("state", state);
    return { url: url.toString(), state, redirectUri };
  },

  async connect(input: SocialConnectInput) {
    if (!input.authCode || !input.state) {
      throw new Error("Facebook connect requires an OAuth authCode and state.");
    }
    const stashed = pending.take(input.state);
    const redirectUri = input.redirectUri ?? stashed?.redirectUri;
    if (!redirectUri) {
      throw new Error("Facebook OAuth session expired. Please reconnect.");
    }
    const shortLived = await exchangeCodeForUserToken(input.authCode, redirectUri);
    const userToken = await exchangeForLongLivedToken(shortLived);

    const pages = await listManagedPages(userToken);
    if (pages.length === 0) {
      throw new Error(
        "No Facebook Pages found for this account. The Graph API can only post to Pages you administer.",
      );
    }
    const wantedId = input.extras?.pageId;
    const page =
      (typeof wantedId === "string" &&
        pages.find((p) => p.id === wantedId)) ||
      pages[0];

    const externalId = page.id;
    // Persist the Page access token (long-lived, non-expiring).
    const bundle: SocialTokenBundle = { accessToken: page.access_token };
    const vaultSecretId = saveTokens("facebook", externalId, bundle);

    return {
      externalId,
      label: page.name,
      credentials: {
        vaultSecretId,
        handle: page.name,
        displayName: page.name,
        expiresAt: null,
        extra: {
          pageId: externalId,
          pageName: page.name,
          managedPages: pages.map((p) => ({ id: p.id, name: p.name })),
        },
      },
    };
  },

  async post(
    credentials: SocialAccountCredentials,
    payload: SocialPostPayload,
  ): Promise<SocialPostResult> {
    const { token, pageId } = pageToken(credentials);
    const linkUrl =
      (payload.extras?.url as string | undefined) ?? payload.media?.[0]?.url;
    const body = new URLSearchParams({ message: payload.text, access_token: token });
    if (linkUrl) body.set("link", linkUrl);
    const res = await fetch(`${GRAPH_BASE}/${pageId}/feed`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!res.ok) {
      throw new Error(
        `Facebook post failed (${res.status}): ${await res.text().catch(() => "")}`,
      );
    }
    const json = (await res.json()) as { id?: string };
    if (!json.id) throw new Error("Facebook post returned no id.");
    return {
      externalPostId: json.id,
      permalink: `https://www.facebook.com/${json.id.replace("_", "/posts/")}`,
      raw: json,
    };
  },

  async fetchEngagements(
    credentials: SocialAccountCredentials,
    options: FetchEngagementsOptions,
  ): Promise<SocialEngagementData[]> {
    const { token, pageId } = pageToken(credentials);
    const limit = Math.min(Math.max(options.limit ?? 25, 5), 100);
    // Pull recent Page posts, then their comments.
    const postIds =
      options.externalPostIds && options.externalPostIds.length > 0
        ? options.externalPostIds
        : await recentPostIds(token, pageId, limit);

    const out: SocialEngagementData[] = [];
    for (const postId of postIds) {
      const url = new URL(`${GRAPH_BASE}/${postId}/comments`);
      url.searchParams.set("fields", "id,message,from,created_time,permalink_url");
      url.searchParams.set("limit", String(limit));
      url.searchParams.set("access_token", token);
      const res = await fetch(url.toString());
      if (!res.ok) continue;
      const json = (await res.json()) as {
        data?: Array<{
          id: string;
          message?: string;
          from?: { id: string; name?: string };
          created_time?: string;
          permalink_url?: string;
        }>;
      };
      for (const c of json.data ?? []) {
        const createdMs = c.created_time
          ? new Date(c.created_time).getTime()
          : Date.now();
        if (options.sinceMs && createdMs <= options.sinceMs) continue;
        out.push({
          externalId: c.id,
          type: "comment",
          externalParentId: postId,
          authorHandle: c.from?.name,
          authorDisplayName: c.from?.name,
          text: c.message ?? "",
          permalink: c.permalink_url,
          receivedAt: createdMs,
          raw: c,
        });
      }
    }
    return out;
  },

  async reply(
    credentials: SocialAccountCredentials,
    engagement: { externalId: string },
    text: string,
  ): Promise<SocialReplyResult> {
    const { token } = pageToken(credentials);
    const body = new URLSearchParams({ message: text, access_token: token });
    const res = await fetch(`${GRAPH_BASE}/${engagement.externalId}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!res.ok) {
      throw new Error(`Facebook reply failed (${res.status}).`);
    }
    const json = (await res.json()) as { id?: string };
    if (!json.id) throw new Error("Facebook reply returned no id.");
    return { externalReplyId: json.id, raw: json };
  },

  async fetchMetrics(
    credentials: SocialAccountCredentials,
    externalPostId: string,
  ): Promise<SocialMetricsData> {
    const { token } = pageToken(credentials);
    const url = new URL(`${GRAPH_BASE}/${externalPostId}`);
    url.searchParams.set(
      "fields",
      "likes.summary(true),comments.summary(true),shares",
    );
    url.searchParams.set("access_token", token);
    const res = await fetch(url.toString());
    if (!res.ok) {
      throw new Error(`Facebook metrics fetch failed (${res.status}).`);
    }
    const json = (await res.json()) as {
      likes?: { summary?: { total_count?: number } };
      comments?: { summary?: { total_count?: number } };
      shares?: { count?: number };
    };
    return {
      likes: json.likes?.summary?.total_count,
      comments: json.comments?.summary?.total_count,
      shares: json.shares?.count,
    };
  },
};

async function recentPostIds(
  token: string,
  pageId: string,
  limit: number,
): Promise<string[]> {
  const url = new URL(`${GRAPH_BASE}/${pageId}/posts`);
  url.searchParams.set("fields", "id");
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("access_token", token);
  const res = await fetch(url.toString());
  if (!res.ok) return [];
  const json = (await res.json()) as { data?: Array<{ id: string }> };
  return (json.data ?? []).map((p) => p.id);
}
