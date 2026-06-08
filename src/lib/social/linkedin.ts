/**
 * LinkedIn adapter (OAuth 2.0, member share API).
 *
 * Implements:
 *   - OAuth2 authorize URL (`/oauth/v2/authorization`)
 *   - code → token exchange (`/oauth/v2/accessToken`)
 *   - identity via OpenID Connect (`/v2/userinfo`)
 *   - publish a text share on the member's feed (`POST /v2/ugcPosts`)
 *
 * LinkedIn's standard "Sign In + Share" products issue 60-day access tokens
 * with no refresh token, so reconnecting is required on expiry. Reading
 * comments / metrics on member posts needs additional partner products and is
 * therefore left disabled in the capability flags.
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
  SocialAdapter,
  SocialAdapterCapabilities,
  SocialAuthUrl,
  SocialConnectInput,
  SocialPostResult,
} from "./types";

const logger = log.scope("social:linkedin");

const AUTHORIZE_URL = "https://www.linkedin.com/oauth/v2/authorization";
const TOKEN_URL = "https://www.linkedin.com/oauth/v2/accessToken";
const API_BASE = "https://api.linkedin.com/v2";
const SCOPES = ["openid", "profile", "email", "w_member_social"];

const pending = new PendingAuthStore();

const CAPABILITIES: SocialAdapterCapabilities = {
  canPublish: true,
  canReadEngagements: false,
  canReply: false,
  canMetrics: false,
  canUploadMedia: false,
  oauth: true,
  maxTextLength: 3000,
  mediaTypes: [],
};

function requireApp() {
  const app = getAppCredentials("linkedin");
  if (!app?.clientId || !app.clientSecret) {
    throw new Error(
      "LinkedIn is not configured. Add your LinkedIn app's client id and secret in Settings → Social.",
    );
  }
  return app;
}

async function exchangeCode(
  code: string,
  redirectUri: string,
): Promise<SocialTokenBundle> {
  const app = requireApp();
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: app.clientId,
    client_secret: app.clientSecret ?? "",
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    throw new Error(
      `LinkedIn token exchange failed (${res.status}): ${await res
        .text()
        .catch(() => "")}`,
    );
  }
  const json = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
    scope?: string;
  };
  if (!json.access_token) {
    throw new Error("LinkedIn token exchange returned no access token.");
  }
  return {
    accessToken: json.access_token,
    expiresAt: json.expires_in ? Date.now() + json.expires_in * 1000 : undefined,
    scopes: json.scope ? json.scope.split(/[\s,]+/) : SCOPES,
  };
}

async function getAccessToken(
  credentials: SocialAccountCredentials,
): Promise<string> {
  const secretId = credentials.vaultSecretId;
  if (!secretId) {
    throw new Error("LinkedIn account is missing its stored credentials. Reconnect it.");
  }
  const bundle = loadTokens(secretId);
  if (!bundle) {
    throw new Error("LinkedIn tokens not found. Reconnect the account.");
  }
  if (typeof bundle.expiresAt === "number" && bundle.expiresAt <= Date.now()) {
    throw new Error("LinkedIn session expired. Reconnect the account.");
  }
  return bundle.accessToken;
}

export const linkedinAdapter: SocialAdapter = {
  provider: "linkedin",
  capabilities: CAPABILITIES,

  async getAuthUrl({ redirectUri }): Promise<SocialAuthUrl> {
    const app = requireApp();
    const state = randomState();
    pending.remember(state, { redirectUri });
    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", app.clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("scope", SCOPES.join(" "));
    url.searchParams.set("state", state);
    return { url: url.toString(), state, redirectUri };
  },

  async connect(input: SocialConnectInput) {
    if (!input.authCode || !input.state) {
      throw new Error("LinkedIn connect requires an OAuth authCode and state.");
    }
    const stashed = pending.take(input.state);
    const redirectUri = input.redirectUri ?? stashed?.redirectUri;
    if (!redirectUri) {
      throw new Error("LinkedIn OAuth session expired. Please reconnect.");
    }
    const tokens = await exchangeCode(input.authCode, redirectUri);

    const meRes = await fetch(`${API_BASE}/userinfo`, {
      headers: { Authorization: `Bearer ${tokens.accessToken}` },
    });
    if (!meRes.ok) {
      throw new Error(`LinkedIn identity lookup failed (${meRes.status}).`);
    }
    const me = (await meRes.json()) as {
      sub: string;
      name?: string;
      picture?: string;
    };
    if (!me.sub) {
      throw new Error("LinkedIn identity lookup returned no member id.");
    }
    const externalId = me.sub;
    const vaultSecretId = saveTokens("linkedin", externalId, tokens);

    return {
      externalId,
      label: me.name ?? "LinkedIn member",
      credentials: {
        vaultSecretId,
        handle: me.name,
        displayName: me.name,
        avatarUrl: me.picture,
        scopes: tokens.scopes,
        expiresAt: tokens.expiresAt ?? null,
        extra: { memberId: externalId },
      },
    };
  },

  async post(
    credentials: SocialAccountCredentials,
    payload: SocialPostPayload,
  ): Promise<SocialPostResult> {
    const token = await getAccessToken(credentials);
    const memberId = credentials.extra?.memberId;
    if (typeof memberId !== "string" || !memberId) {
      throw new Error("LinkedIn account is missing its member id. Reconnect it.");
    }
    const authorUrn = `urn:li:person:${memberId}`;
    const res = await fetch(`${API_BASE}/ugcPosts`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-Restli-Protocol-Version": "2.0.0",
      },
      body: JSON.stringify({
        author: authorUrn,
        lifecycleState: "PUBLISHED",
        specificContent: {
          "com.linkedin.ugc.ShareContent": {
            shareCommentary: { text: payload.text },
            shareMediaCategory: "NONE",
          },
        },
        visibility: {
          "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC",
        },
      }),
    });
    if (!res.ok) {
      throw new Error(
        `LinkedIn post failed (${res.status}): ${await res.text().catch(() => "")}`,
      );
    }
    const urn =
      res.headers.get("x-restli-id") ??
      ((await res.json().catch(() => ({}))) as { id?: string }).id;
    if (!urn) throw new Error("LinkedIn post returned no share id.");
    logger.debug(`published share ${urn}`);
    return {
      externalPostId: urn,
      permalink: `https://www.linkedin.com/feed/update/${urn}`,
      raw: { id: urn },
    };
  },
};
