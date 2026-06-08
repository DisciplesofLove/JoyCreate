/**
 * Twitter / X adapter (OAuth 2.0 PKCE, API v2).
 *
 * Implements the full loop against the X API v2:
 *   - OAuth2 authorize URL with PKCE (`/i/oauth2/authorize`)
 *   - code → token exchange + refresh-token rotation (`/2/oauth2/token`)
 *   - publish tweets (`POST /2/tweets`)
 *   - read mentions (`GET /2/users/:id/mentions`)
 *   - reply to a tweet (`POST /2/tweets` with `reply.in_reply_to_tweet_id`)
 *   - per-tweet public metrics (`GET /2/tweets/:id?tweet.fields=public_metrics`)
 *
 * App credentials (client id + optional secret + redirect) come from the
 * social credential store (BYOK), with env-var fallback. Some read endpoints
 * require an elevated X API access tier; when the tier is insufficient the
 * provider's error is surfaced to the UI unchanged.
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
  updateTokens,
} from "./credentials";
import { PendingAuthStore, generatePkce, randomState } from "./oauth_helpers";
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

const logger = log.scope("social:twitter");

const AUTHORIZE_URL = "https://twitter.com/i/oauth2/authorize";
const TOKEN_URL = "https://api.twitter.com/2/oauth2/token";
const API_BASE = "https://api.twitter.com/2";
const SCOPES = ["tweet.read", "tweet.write", "users.read", "offline.access"];

const pending = new PendingAuthStore();

const CAPABILITIES: SocialAdapterCapabilities = {
  canPublish: true,
  canReadEngagements: true,
  canReply: true,
  canMetrics: true,
  canUploadMedia: false,
  oauth: true,
  maxTextLength: 280,
  mediaTypes: [],
};

function requireApp() {
  const app = getAppCredentials("twitter");
  if (!app?.clientId) {
    throw new Error(
      "Twitter/X is not configured. Add your X app's client id (and secret for confidential apps) in Settings → Social.",
    );
  }
  return app;
}

/** Confidential apps authenticate the token endpoint with HTTP Basic. */
function tokenAuthHeaders(): Record<string, string> {
  const app = requireApp();
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
  };
  if (app.clientSecret) {
    const raw = `${app.clientId}:${app.clientSecret}`;
    headers.Authorization = `Basic ${Buffer.from(raw).toString("base64")}`;
  }
  return headers;
}

async function exchangeCode(
  code: string,
  redirectUri: string,
  codeVerifier: string,
): Promise<SocialTokenBundle> {
  const app = requireApp();
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
    client_id: app.clientId,
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: tokenAuthHeaders(),
    body,
  });
  if (!res.ok) {
    throw new Error(
      `Twitter token exchange failed (${res.status}): ${await res
        .text()
        .catch(() => "")}`,
    );
  }
  const json = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  };
  if (!json.access_token) {
    throw new Error("Twitter token exchange returned no access token.");
  }
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: json.expires_in ? Date.now() + json.expires_in * 1000 : undefined,
    scopes: json.scope ? json.scope.split(/\s+/) : SCOPES,
  };
}

async function refreshTokens(
  bundle: SocialTokenBundle,
): Promise<SocialTokenBundle> {
  const app = requireApp();
  if (!bundle.refreshToken) {
    throw new Error(
      "Twitter session expired and no refresh token is available. Reconnect the account.",
    );
  }
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: bundle.refreshToken,
    client_id: app.clientId,
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: tokenAuthHeaders(),
    body,
  });
  if (!res.ok) {
    throw new Error(`Twitter token refresh failed (${res.status}).`);
  }
  const json = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  };
  return {
    ...bundle,
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? bundle.refreshToken,
    expiresAt: json.expires_in ? Date.now() + json.expires_in * 1000 : undefined,
    scopes: json.scope ? json.scope.split(/\s+/) : bundle.scopes,
  };
}

async function getAccessToken(
  credentials: SocialAccountCredentials,
): Promise<string> {
  const secretId = credentials.vaultSecretId;
  if (!secretId) {
    throw new Error("Twitter account is missing its stored credentials. Reconnect it.");
  }
  let bundle = loadTokens(secretId);
  if (!bundle) {
    throw new Error("Twitter tokens not found. Reconnect the account.");
  }
  const expiringSoon =
    typeof bundle.expiresAt === "number" && bundle.expiresAt - Date.now() < 60_000;
  if (expiringSoon) {
    bundle = await refreshTokens(bundle);
    updateTokens(secretId, bundle);
  }
  return bundle.accessToken;
}

async function apiFetch(
  token: string,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  return fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      Authorization: `Bearer ${token}`,
    },
  });
}

function requireUserId(credentials: SocialAccountCredentials): string {
  const id = credentials.extra?.userId;
  if (typeof id !== "string" || !id) {
    throw new Error("Twitter account is missing its user id. Reconnect it.");
  }
  return id;
}

export const twitterAdapter: SocialAdapter = {
  provider: "twitter",
  capabilities: CAPABILITIES,

  async getAuthUrl({ redirectUri }): Promise<SocialAuthUrl> {
    const app = requireApp();
    const state = randomState();
    const pkce = generatePkce();
    pending.remember(state, { redirectUri, codeVerifier: pkce.verifier });
    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", app.clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("scope", SCOPES.join(" "));
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", pkce.challenge);
    url.searchParams.set("code_challenge_method", pkce.method);
    return { url: url.toString(), state, redirectUri };
  },

  async connect(input: SocialConnectInput) {
    if (!input.authCode || !input.state) {
      throw new Error("Twitter connect requires an OAuth authCode and state.");
    }
    const stashed = pending.take(input.state);
    const redirectUri = input.redirectUri ?? stashed?.redirectUri;
    if (!redirectUri || !stashed?.codeVerifier) {
      throw new Error("Twitter OAuth session expired. Please reconnect.");
    }
    const tokens = await exchangeCode(
      input.authCode,
      redirectUri,
      stashed.codeVerifier,
    );

    const meRes = await apiFetch(tokens.accessToken, "/users/me");
    if (!meRes.ok) {
      throw new Error(`Twitter identity lookup failed (${meRes.status}).`);
    }
    const me = (await meRes.json()) as {
      data?: { id: string; username: string; name?: string };
    };
    if (!me.data?.id) {
      throw new Error("Twitter identity lookup returned no user.");
    }
    const externalId = me.data.id;
    const vaultSecretId = saveTokens("twitter", externalId, tokens);

    return {
      externalId,
      label: `@${me.data.username}`,
      credentials: {
        vaultSecretId,
        handle: `@${me.data.username}`,
        displayName: me.data.name ?? me.data.username,
        scopes: tokens.scopes,
        expiresAt: tokens.expiresAt ?? null,
        extra: { userId: externalId, username: me.data.username },
      },
    };
  },

  async post(
    credentials: SocialAccountCredentials,
    payload: SocialPostPayload,
  ): Promise<SocialPostResult> {
    const token = await getAccessToken(credentials);
    const res = await apiFetch(token, "/tweets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: payload.text }),
    });
    if (!res.ok) {
      throw new Error(
        `Twitter post failed (${res.status}): ${await res.text().catch(() => "")}`,
      );
    }
    const json = (await res.json()) as { data?: { id: string } };
    const id = json.data?.id;
    if (!id) throw new Error("Twitter post returned no tweet id.");
    const username = credentials.extra?.username as string | undefined;
    return {
      externalPostId: id,
      permalink: username
        ? `https://x.com/${username}/status/${id}`
        : `https://x.com/i/status/${id}`,
      raw: json,
    };
  },

  async fetchEngagements(
    credentials: SocialAccountCredentials,
    options: FetchEngagementsOptions,
  ): Promise<SocialEngagementData[]> {
    const token = await getAccessToken(credentials);
    const userId = requireUserId(credentials);
    const max = Math.min(Math.max(options.limit ?? 25, 5), 100);
    const params = new URLSearchParams({
      max_results: String(max),
      "tweet.fields": "created_at,author_id,conversation_id",
      expansions: "author_id",
      "user.fields": "username,name",
    });
    const res = await apiFetch(
      token,
      `/users/${userId}/mentions?${params.toString()}`,
    );
    if (!res.ok) {
      throw new Error(
        `Twitter mentions fetch failed (${res.status}). This endpoint requires an elevated X API tier.`,
      );
    }
    const json = (await res.json()) as {
      data?: Array<{
        id: string;
        text: string;
        author_id?: string;
        conversation_id?: string;
        created_at?: string;
      }>;
      includes?: {
        users?: Array<{ id: string; username: string; name?: string }>;
      };
    };
    const users = new Map((json.includes?.users ?? []).map((u) => [u.id, u]));
    const out: SocialEngagementData[] = [];
    for (const tweet of json.data ?? []) {
      const createdMs = tweet.created_at
        ? new Date(tweet.created_at).getTime()
        : Date.now();
      if (options.sinceMs && createdMs <= options.sinceMs) continue;
      const author = tweet.author_id ? users.get(tweet.author_id) : undefined;
      out.push({
        externalId: tweet.id,
        type: "mention",
        externalParentId: tweet.conversation_id,
        authorHandle: author ? `@${author.username}` : undefined,
        authorDisplayName: author?.name ?? author?.username,
        text: tweet.text,
        permalink: author
          ? `https://x.com/${author.username}/status/${tweet.id}`
          : `https://x.com/i/status/${tweet.id}`,
        receivedAt: createdMs,
        raw: tweet,
      });
    }
    return out;
  },

  async reply(
    credentials: SocialAccountCredentials,
    engagement: { externalId: string },
    text: string,
  ): Promise<SocialReplyResult> {
    const token = await getAccessToken(credentials);
    const res = await apiFetch(token, "/tweets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        reply: { in_reply_to_tweet_id: engagement.externalId },
      }),
    });
    if (!res.ok) {
      throw new Error(`Twitter reply failed (${res.status}).`);
    }
    const json = (await res.json()) as { data?: { id: string } };
    const id = json.data?.id;
    if (!id) throw new Error("Twitter reply returned no tweet id.");
    return { externalReplyId: id, raw: json };
  },

  async fetchMetrics(
    credentials: SocialAccountCredentials,
    externalPostId: string,
  ): Promise<SocialMetricsData> {
    const token = await getAccessToken(credentials);
    const res = await apiFetch(
      token,
      `/tweets/${encodeURIComponent(externalPostId)}?tweet.fields=public_metrics`,
    );
    if (!res.ok) {
      throw new Error(`Twitter metrics fetch failed (${res.status}).`);
    }
    const json = (await res.json()) as {
      data?: {
        public_metrics?: {
          impression_count?: number;
          like_count?: number;
          reply_count?: number;
          retweet_count?: number;
          quote_count?: number;
        };
      };
    };
    const m = json.data?.public_metrics;
    if (!m) return {};
    logger.debug(`metrics for ${externalPostId}: likes=${m.like_count}`);
    return {
      impressions: m.impression_count,
      likes: m.like_count,
      comments: m.reply_count,
      shares: (m.retweet_count ?? 0) + (m.quote_count ?? 0),
    };
  },
};
