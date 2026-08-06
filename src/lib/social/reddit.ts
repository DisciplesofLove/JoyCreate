/**
 * Reddit adapter — the fully-wired reference platform.
 *
 * Implements the complete loop against Reddit's OAuth2 API:
 *   - OAuth authorize URL + code exchange (`/api/v1/access_token`)
 *   - automatic refresh-token rotation
 *   - submit self / link posts (`/api/submit`)
 *   - read inbound replies + mentions (`/message/inbox`)
 *   - reply to a thing (`/api/comment`)
 *   - fetch basic metrics (`/api/info`)
 *
 * App credentials (client id / secret / redirect) come from the social
 * credential store (BYOK), with env-var fallback. Per-account tokens are
 * persisted encrypted and referenced by `vaultSecretId`.
 */

import { randomBytes } from "node:crypto";
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

const logger = log.scope("social:reddit");

const USER_AGENT = "JoyCreate/1.0 (autonomous social agent)";
const OAUTH_BASE = "https://oauth.reddit.com";
const WWW_BASE = "https://www.reddit.com";
const SCOPES = ["identity", "submit", "read", "edit", "history", "privatemessages"];

const CAPABILITIES: SocialAdapterCapabilities = {
  canPublish: true,
  canReadEngagements: true,
  canReply: true,
  canMetrics: true,
  canUploadMedia: false,
  oauth: true,
  maxTextLength: 40000,
  mediaTypes: [],
};

function requireApp() {
  const app = getAppCredentials("reddit");
  if (!app?.clientId) {
    throw new Error(
      "Reddit is not configured. Add your Reddit app's client id / secret in Settings → Social.",
    );
  }
  return app;
}

function basicAuthHeader(): string {
  const app = requireApp();
  const raw = `${app.clientId}:${app.clientSecret ?? ""}`;
  return `Basic ${Buffer.from(raw).toString("base64")}`;
}

async function exchangeCode(
  code: string,
  redirectUri: string,
): Promise<SocialTokenBundle> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
  });
  const res = await fetch(`${WWW_BASE}/api/v1/access_token`, {
    method: "POST",
    headers: {
      Authorization: basicAuthHeader(),
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": USER_AGENT,
    },
    body,
  });
  if (!res.ok) {
    throw new Error(
      `Reddit token exchange failed (${res.status}): ${await res
        .text()
        .catch(() => "")}`,
    );
  }
  const json = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    error?: string;
  };
  if (json.error || !json.access_token) {
    throw new Error(`Reddit token exchange error: ${json.error ?? "no token"}`);
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
  if (!bundle.refreshToken) {
    throw new Error("Reddit session expired and no refresh token is available. Reconnect the account.");
  }
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: bundle.refreshToken,
  });
  const res = await fetch(`${WWW_BASE}/api/v1/access_token`, {
    method: "POST",
    headers: {
      Authorization: basicAuthHeader(),
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": USER_AGENT,
    },
    body,
  });
  if (!res.ok) {
    throw new Error(`Reddit token refresh failed (${res.status})`);
  }
  const json = (await res.json()) as {
    access_token: string;
    expires_in?: number;
    scope?: string;
  };
  return {
    ...bundle,
    accessToken: json.access_token,
    expiresAt: json.expires_in ? Date.now() + json.expires_in * 1000 : undefined,
    scopes: json.scope ? json.scope.split(/\s+/) : bundle.scopes,
  };
}

/** Resolve a live access token for a stored account, refreshing if needed. */
async function getAccessToken(
  credentials: SocialAccountCredentials,
): Promise<string> {
  const secretId = credentials.vaultSecretId;
  if (!secretId) {
    throw new Error("Reddit account is missing its stored credentials. Reconnect it.");
  }
  let bundle = loadTokens(secretId);
  if (!bundle) {
    throw new Error("Reddit tokens not found. Reconnect the account.");
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
  return fetch(`${OAUTH_BASE}${path}`, {
    ...init,
    headers: {
      ...init?.headers,
      Authorization: `Bearer ${token}`,
      "User-Agent": USER_AGENT,
    },
  });
}

export const redditAdapter: SocialAdapter = {
  provider: "reddit",
  capabilities: CAPABILITIES,

  async getAuthUrl({ redirectUri }): Promise<SocialAuthUrl> {
    const app = requireApp();
    const state = randomBytes(16).toString("hex");
    const url = new URL(`${WWW_BASE}/api/v1/authorize`);
    url.searchParams.set("client_id", app.clientId);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("state", state);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("duration", "permanent");
    url.searchParams.set("scope", SCOPES.join(" "));
    return { url: url.toString(), state, redirectUri };
  },

  async connect(input: SocialConnectInput) {
    if (!input.authCode || !input.redirectUri) {
      throw new Error("Reddit connect requires an OAuth authCode and redirectUri.");
    }
    const tokens = await exchangeCode(input.authCode, input.redirectUri);

    // Identify the account.
    const meRes = await apiFetch(tokens.accessToken, "/api/v1/me");
    if (!meRes.ok) {
      throw new Error(`Reddit identity lookup failed (${meRes.status}).`);
    }
    const me = (await meRes.json()) as {
      name: string;
      icon_img?: string;
    };
    const externalId = me.name;
    const vaultSecretId = saveTokens("reddit", externalId, tokens);

    return {
      externalId,
      label: `u/${externalId}`,
      credentials: {
        vaultSecretId,
        handle: `u/${externalId}`,
        displayName: me.name,
        avatarUrl: me.icon_img?.split("?")[0],
        scopes: tokens.scopes,
        expiresAt: tokens.expiresAt ?? null,
      },
    };
  },

  async post(
    credentials: SocialAccountCredentials,
    payload: SocialPostPayload,
  ): Promise<SocialPostResult> {
    const token = await getAccessToken(credentials);
    const extras = (payload.extras ?? {}) as Record<string, unknown>;
    const subreddit =
      (extras.subreddit as string | undefined) ??
      (credentials.extra?.defaultSubreddit as string | undefined);
    if (!subreddit) {
      throw new Error(
        "Reddit posts need a target subreddit. Set `extras.subreddit` or a default on the account.",
      );
    }
    const linkUrl =
      (extras.url as string | undefined) ?? payload.media?.[0]?.url;
    const title =
      (extras.title as string | undefined) ??
      payload.text.split("\n")[0].slice(0, 300) ??
      "Untitled";

    const form = new URLSearchParams({
      api_type: "json",
      sr: subreddit.replace(/^r\//, ""),
      title,
    });
    if (linkUrl) {
      form.set("kind", "link");
      form.set("url", linkUrl);
    } else {
      form.set("kind", "self");
      form.set("text", payload.text);
    }

    const res = await apiFetch(token, "/api/submit", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
    });
    if (!res.ok) {
      throw new Error(`Reddit submit failed (${res.status}): ${await res.text().catch(() => "")}`);
    }
    const json = (await res.json()) as {
      json?: {
        errors?: string[][];
        data?: { url?: string; name?: string; id?: string };
      };
    };
    const errors = json.json?.errors ?? [];
    if (errors.length > 0) {
      throw new Error(`Reddit submit error: ${errors.map((e) => e.join(": ")).join("; ")}`);
    }
    const data = json.json?.data;
    if (!data?.name) {
      throw new Error("Reddit submit returned no post id.");
    }
    return {
      externalPostId: data.name,
      permalink: data.url,
      raw: json,
    };
  },

  async fetchEngagements(
    credentials: SocialAccountCredentials,
    options: FetchEngagementsOptions,
  ): Promise<SocialEngagementData[]> {
    const token = await getAccessToken(credentials);
    const limit = Math.min(options.limit ?? 50, 100);
    const res = await apiFetch(token, `/message/inbox?limit=${limit}`);
    if (!res.ok) {
      throw new Error(`Reddit inbox fetch failed (${res.status}).`);
    }
    const json = (await res.json()) as {
      data?: { children?: Array<{ kind: string; data: Record<string, any> }> };
    };
    const children = json.data?.children ?? [];
    const out: SocialEngagementData[] = [];
    for (const child of children) {
      const d = child.data;
      const createdMs = Math.round((d.created_utc ?? 0) * 1000);
      if (options.sinceMs && createdMs <= options.sinceMs) continue;
      const isMention = d.type === "username_mention";
      out.push({
        externalId: d.name,
        type: isMention ? "mention" : "comment",
        externalParentId: d.parent_id,
        authorHandle: d.author ? `u/${d.author}` : undefined,
        authorDisplayName: d.author,
        text: d.body ?? "",
        permalink: d.context ? `${WWW_BASE}${d.context}` : undefined,
        receivedAt: createdMs,
        raw: d,
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
    const form = new URLSearchParams({
      api_type: "json",
      thing_id: engagement.externalId,
      text,
    });
    const res = await apiFetch(token, "/api/comment", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
    });
    if (!res.ok) {
      throw new Error(`Reddit reply failed (${res.status}).`);
    }
    const json = (await res.json()) as {
      json?: { errors?: string[][]; data?: { things?: Array<{ data: { name: string } }> } };
    };
    const errors = json.json?.errors ?? [];
    if (errors.length > 0) {
      throw new Error(`Reddit reply error: ${errors.map((e) => e.join(": ")).join("; ")}`);
    }
    const name = json.json?.data?.things?.[0]?.data?.name;
    if (!name) throw new Error("Reddit reply returned no comment id.");
    return { externalReplyId: name, raw: json };
  },

  async fetchMetrics(
    credentials: SocialAccountCredentials,
    externalPostId: string,
  ): Promise<SocialMetricsData> {
    const token = await getAccessToken(credentials);
    const res = await apiFetch(token, `/api/info?id=${encodeURIComponent(externalPostId)}`);
    if (!res.ok) {
      throw new Error(`Reddit info fetch failed (${res.status}).`);
    }
    const json = (await res.json()) as {
      data?: { children?: Array<{ data: Record<string, any> }> };
    };
    const d = json.data?.children?.[0]?.data;
    if (!d) return {};
    logger.debug(`metrics for ${externalPostId}: ups=${d.ups} comments=${d.num_comments}`);
    return {
      likes: typeof d.ups === "number" ? d.ups : undefined,
      comments: typeof d.num_comments === "number" ? d.num_comments : undefined,
    };
  },
};
