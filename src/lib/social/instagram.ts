/**
 * Instagram adapter (stub).
 *
 * Real implementation should:
 *   - Use Instagram Graph API with a Facebook Page connection.
 *   - Two-step publish: create media container, then `POST /media_publish`.
 */

import type {
  SocialAccountCredentials,
  SocialPostPayload,
} from "@/db/social_schema";
import type { SocialAdapter, SocialPostResult } from "./types";

const NOT_CONFIGURED =
  "Instagram is not yet configured. Add API credentials in Settings \u2192 Integrations.";

export const instagramAdapter: SocialAdapter = {
  provider: "instagram",
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
