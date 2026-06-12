/**
 * Social OAuth + app-credential handlers.
 *
 * Channels:
 *   social:list-supported       providers that can be connected right now
 *   social:get-provider-config  per-provider app-credential readiness
 *   social:set-app-credentials  store a provider's OAuth client id / secret
 *   social:begin-oauth          run the loopback OAuth flow + connect account
 *
 * The OAuth flow opens the provider's authorize page in the user's browser and
 * captures the redirect on a localhost loopback HTTP server, exchanging the
 * code through the provider adapter. State is validated to prevent CSRF.
 */

import * as http from "node:http";
import { and, eq } from "drizzle-orm";
import { shell } from "electron";
import log from "electron-log";

import {
  getAppCredentials,
  hasAppCredentials,
  setAppCredentials,
} from "@/lib/social/credentials";
import {
  getSocialAdapter,
  listProviderInfo,
  listSupportedProviders,
} from "@/lib/social/registry";
import { db } from "../../db";
import {
  type SocialAccountCredentials,
  type SocialProvider,
  socialAccounts,
} from "../../db/social_schema";
import { createLoggedHandler } from "./safe_handle";
import { type SocialAccountDto, toAccountDto } from "./social_handlers";

const logger = log.scope("social:oauth");
const handle = createLoggedHandler(logger);

const DEFAULT_REDIRECT_URI = "http://localhost:53682/callback";
const OAUTH_TIMEOUT_MS = 5 * 60 * 1000;

const SUCCESS_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Connected</title>
<style>body{font-family:system-ui,sans-serif;background:#0b0b0f;color:#e7e7ea;display:flex;
align-items:center;justify-content:center;height:100vh;margin:0}div{text-align:center}
h1{font-size:1.25rem;margin:0 0 .5rem}p{opacity:.7;margin:0}</style></head>
<body><div><h1>Account connected</h1><p>You can close this window and return to JoyCreate.</p></div></body></html>`;

const ERROR_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Failed</title>
<style>body{font-family:system-ui,sans-serif;background:#0b0b0f;color:#e7e7ea;display:flex;
align-items:center;justify-content:center;height:100vh;margin:0}div{text-align:center}
h1{font-size:1.25rem;margin:0 0 .5rem}p{opacity:.7;margin:0}</style></head>
<body><div><h1>Connection failed</h1><p>You can close this window and try again in JoyCreate.</p></div></body></html>`;

interface OAuthCallbackResult {
  code: string;
  state: string | null;
}

/**
 * Listen on the redirect URI's loopback port for a single OAuth callback,
 * validating the returned state. Always tears the server down.
 */
function waitForOAuthCallback(
  redirectUri: string,
  expectedState: string,
): Promise<OAuthCallbackResult> {
  const parsed = new URL(redirectUri);
  const port = Number.parseInt(parsed.port || "80", 10);
  const expectedPath = parsed.pathname || "/";
  // OAuth providers always redirect to a loopback address (127.0.0.1 or
  // localhost). Bind to the loopback interface explicitly so an attacker on
  // the same LAN can't race a request to our transient callback server and
  // steal the authorization code (a brief window, but the cost is zero).
  const bindHost = parsed.hostname && parsed.hostname.length > 0
    ? parsed.hostname
    : "127.0.0.1";

  return new Promise<OAuthCallbackResult>((resolve, reject) => {
    let settled = false;
    const server = http.createServer((req, res) => {
      try {
        const reqUrl = new URL(req.url ?? "/", `http://localhost:${port}`);
        if (reqUrl.pathname !== expectedPath) {
          res.writeHead(404).end();
          return;
        }
        const error = reqUrl.searchParams.get("error");
        const code = reqUrl.searchParams.get("code");
        const state = reqUrl.searchParams.get("state");

        if (error || !code) {
          res.writeHead(400, { "Content-Type": "text/html" }).end(ERROR_HTML);
          finish(() =>
            reject(new Error(`OAuth was denied or failed: ${error ?? "no code"}`)),
          );
          return;
        }
        if (state !== expectedState) {
          res.writeHead(400, { "Content-Type": "text/html" }).end(ERROR_HTML);
          finish(() => reject(new Error("OAuth state mismatch (possible CSRF).")));
          return;
        }
        res.writeHead(200, { "Content-Type": "text/html" }).end(SUCCESS_HTML);
        finish(() => resolve({ code, state }));
      } catch (err) {
        res.writeHead(500).end();
        finish(() => reject(err instanceof Error ? err : new Error(String(err))));
      }
    });

    const timer = setTimeout(() => {
      finish(() => reject(new Error("OAuth timed out. Please try again.")));
    }, OAUTH_TIMEOUT_MS);

    function finish(action: () => void) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      action();
    }

    server.on("error", (err) => {
      finish(() =>
        reject(
          new Error(
            `Could not start the OAuth callback server on port ${port}: ${err.message}`,
          ),
        ),
      );
    });
    server.listen(port, bindHost);
  });
}

/** Insert or update a connected account row, returning the fresh DTO. */
async function upsertAccount(
  provider: SocialProvider,
  externalId: string,
  label: string,
  credentials: SocialAccountCredentials,
): Promise<SocialAccountDto> {
  const now = new Date();
  const [existing] = await db
    .select()
    .from(socialAccounts)
    .where(
      and(
        eq(socialAccounts.provider, provider),
        eq(socialAccounts.externalId, externalId),
      ),
    )
    .limit(1);

  if (existing) {
    const [row] = await db
      .update(socialAccounts)
      .set({
        label,
        credentialsJson: credentials,
        tokenStatus: "ok",
        updatedAt: now,
      })
      .where(eq(socialAccounts.id, existing.id))
      .returning();
    return toAccountDto(row);
  }

  const [row] = await db
    .insert(socialAccounts)
    .values({
      provider,
      externalId,
      label,
      credentialsJson: credentials,
      enabled: true,
      autoReply: false,
      tokenStatus: "ok",
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return toAccountDto(row);
}

export function registerSocialOAuthHandlers(): void {
  handle(
    "social:list-supported",
    async (): Promise<SocialProvider[]> => listSupportedProviders(),
  );

  handle(
    "social:get-provider-config",
    async (): Promise<
      Array<{
        provider: SocialProvider;
        configured: boolean;
        oauth: boolean;
        redirectUri: string;
      }>
    > => {
      return listProviderInfo().map((info) => {
        const app = getAppCredentials(info.provider);
        return {
          provider: info.provider,
          configured: hasAppCredentials(info.provider),
          oauth: info.capabilities.oauth,
          redirectUri: app?.redirectUri ?? DEFAULT_REDIRECT_URI,
        };
      });
    },
  );

  handle(
    "social:set-app-credentials",
    async (
      _e,
      input: {
        provider: SocialProvider;
        clientId: string;
        clientSecret?: string;
        redirectUri?: string;
      },
    ): Promise<{ configured: boolean }> => {
      if (!input?.provider) throw new Error("A provider is required.");
      if (!input.clientId?.trim()) throw new Error("A client id is required.");
      setAppCredentials(input.provider, {
        clientId: input.clientId.trim(),
        clientSecret: input.clientSecret?.trim() || undefined,
        redirectUri: input.redirectUri?.trim() || DEFAULT_REDIRECT_URI,
      });
      return { configured: true };
    },
  );

  handle(
    "social:begin-oauth",
    async (
      _e,
      input: { provider: SocialProvider },
    ): Promise<SocialAccountDto> => {
      if (!input?.provider) throw new Error("A provider is required.");
      const adapter = getSocialAdapter(input.provider);
      if (!adapter.capabilities.oauth || !adapter.getAuthUrl) {
        throw new Error(`${input.provider} does not support OAuth sign-in yet.`);
      }
      if (!hasAppCredentials(input.provider)) {
        throw new Error(
          `Add your ${input.provider} app credentials before connecting.`,
        );
      }
      const app = getAppCredentials(input.provider);
      const redirectUri = app?.redirectUri ?? DEFAULT_REDIRECT_URI;

      const { url, state } = await adapter.getAuthUrl({ redirectUri });
      const callbackPromise = waitForOAuthCallback(redirectUri, state);
      await shell.openExternal(url);
      const { code } = await callbackPromise;

      const result = await adapter.connect({
        authCode: code,
        state,
        redirectUri,
      });
      return upsertAccount(
        input.provider,
        result.externalId,
        result.label,
        result.credentials,
      );
    },
  );
}
