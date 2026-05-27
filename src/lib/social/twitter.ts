/**
 * Twitter / X adapter (stub).
 *
 * Real implementation should:
 *   - Use OAuth 2.0 PKCE (`https://twitter.com/i/oauth2/authorize`).
 *   - Persist refresh tokens via the vault.
 *   - Call `POST https://api.twitter.com/2/tweets` for text + media.
 *
 * Until those credentials are wired, both methods throw a clear error so
 * the UI surfaces the missing-configuration state instead of silently
 * failing.
 */

import type {
  SocialAccountCredentials,
  SocialPostPayload,
} from "@/db/social_schema";
import type { SocialAdapter, SocialPostResult } from "./types";

const NOT_CONFIGURED =
  "Twitter/X is not yet configured. Add API credentials in Settings \u2192 Integrations.";

export const twitterAdapter: SocialAdapter = {
  provider: "twitter",
  async connect(): Promise<{
    externalId: string;
    label: string;
    credentials: SocialAccountCredentials;
  }> {
    throw new Error(NOT_CONFIGURED);
  },
  async post(
    _credentials: SocialAccountCredentials,
    _payload: SocialPostPayload,
  ): Promise<SocialPostResult> {
    throw new Error(NOT_CONFIGURED);
  },
};
