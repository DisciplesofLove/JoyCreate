/**
 * Instagram adapter (Instagram Graph API via Facebook, v19.0).
 *
 * Instagram Business / Creator accounts are managed through a linked Facebook
 * Page. The flow:
 *   - OAuth2 authorize (Facebook `/dialog/oauth`) with IG + Page scopes
 *   - code → long-lived user token → resolve the linked IG business account
 *   - publish: create a media container (`POST /{ig-id}/media`) then publish it
 *     (`POST /{ig-id}/media_publish`) — requires a publicly reachable image URL
 *   - read + reply to comments (`/{media-id}/comments`, `/{comment-id}/replies`)
 *   - per-media metrics (`like_count`, `comments_count`)
 *
 * Publishing requires `image_url` to be a public HTTPS URL Instagram can fetch;
 * a local file path will be rejected with a clear error.
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

const logger = log.scope("social:instagram");

const GRAPH_VERSION = "v19.0";
const DIALOG_URL = `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth`;
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;
const SCOPES = [
  "public_profile",
  "pages_show_list",
  "pages_read_engagement",
  "business_management",
  "instagram_basic",
  "instagram_content_publish",
  "instagram_manage_comments",
];

const pending = new PendingAuthStore();

const CAPABILITIES: SocialAdapterCapabilities = {
  canPublish: true,
  canReadEngagements: true,
  canReply: true,
  canMetrics: true,
  canUploadMedia: true,
  oauth: true,
  maxTextLength: 2200,
  mediaTypes: ["image"],
};

function requireApp() {
  const app = getAppCredentials("instagram");
  if (!app?.clientId || !app.clientSecret) {
    throw new Error(
      "Instagram is not configured. Add your Meta app's id and secret in Settings → Social.",
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
      `Instagram token exchange failed (${res.status}): ${await res
        .text()
        .catch(() => "")}`,
    );
  }
  const json = (await res.json()) as { access_token?: string };
  if (!json.access_token) {
    throw new Error("Instagram token exchange returned no access token.");
  }
  return json.access_token;
}

async function exchangeForLongLivedToken(shortLived: string): Promise<string> {
  const app = requireApp();
  const url = new URL(`${GRAPH_BASE}/oauth/access_token`);
  url.searchParams.set("grant_type", "fb_exchange_token");
  url.searchParams.set("client_id", app.clientId);
  url.searchParams.set("client_secret", app.clientSecret ?? "");
  url.searchParams.set("fb_exchange_token", shortLived);
  const res = await fetch(url.toString());
  if (!res.ok) return shortLived;
  const json = (await res.json()) as { access_token?: string };
  return json.access_token ?? shortLived;
}

interface IgBinding {
  igUserId: string;
  username?: string;
  pageToken: string;
}

/** Find the first Page with a linked Instagram business account. */
async function resolveIgAccount(userToken: string): Promise<IgBinding> {
  const url = new URL(`${GRAPH_BASE}/me/accounts`);
  url.searchParams.set(
    "fields",
    "id,name,access_token,instagram_business_account{id,username}",
  );
  url.searchParams.set("access_token", userToken);
  const res = await fetch(url.toString());
  if (!res.ok) {
    throw new Error(`Instagram account lookup failed (${res.status}).`);
  }
  const json = (await res.json()) as {
    data?: Array<{
      id: string;
      name: string;
      access_token: string;
      instagram_business_account?: { id: string; username?: string };
    }>;
  };
  for (const page of json.data ?? []) {
    if (page.instagram_business_account?.id) {
      return {
        igUserId: page.instagram_business_account.id,
        username: page.instagram_business_account.username,
        pageToken: page.access_token,
      };
    }
  }
  throw new Error(
    "No Instagram business account is linked to your Facebook Pages. Connect one in Meta Business settings first.",
  );
}

function igContext(credentials: SocialAccountCredentials): {
  token: string;
  igUserId: string;
} {
  const secretId = credentials.vaultSecretId;
  if (!secretId) {
    throw new Error("Instagram account is missing its stored credentials. Reconnect it.");
  }
  const bundle = loadTokens(secretId);
  if (!bundle) {
    throw new Error("Instagram tokens not found. Reconnect the account.");
  }
  const igUserId = credentials.extra?.igUserId;
  if (typeof igUserId !== "string" || !igUserId) {
    throw new Error("Instagram account is missing its user id. Reconnect it.");
  }
  return { token: bundle.accessToken, igUserId };
}

function resolvePublicImageUrl(payload: SocialPostPayload): string {
  const candidate =
    (payload.extras?.imageUrl as string | undefined) ??
    payload.media?.find((m) => m.type !== "video")?.url ??
    payload.media?.[0]?.url;
  if (!candidate || !/^https?:\/\//i.test(candidate)) {
    throw new Error(
      "Instagram requires a public image URL. Provide `extras.imageUrl` (an https link Instagram can fetch); local files are not supported.",
    );
  }
  return candidate;
}

export const instagramAdapter: SocialAdapter = {
  provider: "instagram",
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
      throw new Error("Instagram connect requires an OAuth authCode and state.");
    }
    const stashed = pending.take(input.state);
    const redirectUri = input.redirectUri ?? stashed?.redirectUri;
    if (!redirectUri) {
      throw new Error("Instagram OAuth session expired. Please reconnect.");
    }
    const shortLived = await exchangeCodeForUserToken(input.authCode, redirectUri);
    const userToken = await exchangeForLongLivedToken(shortLived);
    const binding = await resolveIgAccount(userToken);

    const externalId = binding.igUserId;
    const bundle: SocialTokenBundle = { accessToken: binding.pageToken };
    const vaultSecretId = saveTokens("instagram", externalId, bundle);
    const handle = binding.username ? `@${binding.username}` : "Instagram";

    return {
      externalId,
      label: handle,
      credentials: {
        vaultSecretId,
        handle,
        displayName: binding.username,
        expiresAt: null,
        extra: { igUserId: externalId, username: binding.username },
      },
    };
  },

  async post(
    credentials: SocialAccountCredentials,
    payload: SocialPostPayload,
  ): Promise<SocialPostResult> {
    const { token, igUserId } = igContext(credentials);
    const imageUrl = resolvePublicImageUrl(payload);

    // 1) Create a media container.
    const createBody = new URLSearchParams({
      image_url: imageUrl,
      caption: payload.text,
      access_token: token,
    });
    const createRes = await fetch(`${GRAPH_BASE}/${igUserId}/media`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: createBody,
    });
    if (!createRes.ok) {
      throw new Error(
        `Instagram media create failed (${createRes.status}): ${await createRes
          .text()
          .catch(() => "")}`,
      );
    }
    const created = (await createRes.json()) as { id?: string };
    if (!created.id) throw new Error("Instagram media create returned no id.");

    // 2) Publish the container.
    const publishBody = new URLSearchParams({
      creation_id: created.id,
      access_token: token,
    });
    const publishRes = await fetch(`${GRAPH_BASE}/${igUserId}/media_publish`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: publishBody,
    });
    if (!publishRes.ok) {
      throw new Error(
        `Instagram publish failed (${publishRes.status}): ${await publishRes
          .text()
          .catch(() => "")}`,
      );
    }
    const published = (await publishRes.json()) as { id?: string };
    if (!published.id) throw new Error("Instagram publish returned no media id.");
    const username = credentials.extra?.username as string | undefined;
    logger.debug(`published media ${published.id}`);
    return {
      externalPostId: published.id,
      permalink: username ? `https://www.instagram.com/${username}` : undefined,
      raw: published,
    };
  },

  async fetchEngagements(
    credentials: SocialAccountCredentials,
    options: FetchEngagementsOptions,
  ): Promise<SocialEngagementData[]> {
    const { token, igUserId } = igContext(credentials);
    const limit = Math.min(Math.max(options.limit ?? 25, 5), 100);
    const mediaIds =
      options.externalPostIds && options.externalPostIds.length > 0
        ? options.externalPostIds
        : await recentMediaIds(token, igUserId, limit);

    const out: SocialEngagementData[] = [];
    for (const mediaId of mediaIds) {
      const url = new URL(`${GRAPH_BASE}/${mediaId}/comments`);
      url.searchParams.set("fields", "id,text,username,timestamp");
      url.searchParams.set("limit", String(limit));
      url.searchParams.set("access_token", token);
      const res = await fetch(url.toString());
      if (!res.ok) continue;
      const json = (await res.json()) as {
        data?: Array<{
          id: string;
          text?: string;
          username?: string;
          timestamp?: string;
        }>;
      };
      for (const c of json.data ?? []) {
        const createdMs = c.timestamp
          ? new Date(c.timestamp).getTime()
          : Date.now();
        if (options.sinceMs && createdMs <= options.sinceMs) continue;
        out.push({
          externalId: c.id,
          type: "comment",
          externalParentId: mediaId,
          authorHandle: c.username ? `@${c.username}` : undefined,
          authorDisplayName: c.username,
          text: c.text ?? "",
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
    const { token } = igContext(credentials);
    const body = new URLSearchParams({ message: text, access_token: token });
    const res = await fetch(`${GRAPH_BASE}/${engagement.externalId}/replies`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!res.ok) {
      throw new Error(`Instagram reply failed (${res.status}).`);
    }
    const json = (await res.json()) as { id?: string };
    if (!json.id) throw new Error("Instagram reply returned no id.");
    return { externalReplyId: json.id, raw: json };
  },

  async fetchMetrics(
    credentials: SocialAccountCredentials,
    externalPostId: string,
  ): Promise<SocialMetricsData> {
    const { token } = igContext(credentials);
    const url = new URL(`${GRAPH_BASE}/${externalPostId}`);
    url.searchParams.set("fields", "like_count,comments_count");
    url.searchParams.set("access_token", token);
    const res = await fetch(url.toString());
    if (!res.ok) {
      throw new Error(`Instagram metrics fetch failed (${res.status}).`);
    }
    const json = (await res.json()) as {
      like_count?: number;
      comments_count?: number;
    };
    return {
      likes: json.like_count,
      comments: json.comments_count,
    };
  },
};

async function recentMediaIds(
  token: string,
  igUserId: string,
  limit: number,
): Promise<string[]> {
  const url = new URL(`${GRAPH_BASE}/${igUserId}/media`);
  url.searchParams.set("fields", "id");
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("access_token", token);
  const res = await fetch(url.toString());
  if (!res.ok) return [];
  const json = (await res.json()) as { data?: Array<{ id: string }> };
  return (json.data ?? []).map((m) => m.id);
}
