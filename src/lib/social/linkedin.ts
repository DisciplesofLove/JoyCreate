/**
 * LinkedIn adapter (stub).
 *
 * Real implementation should:
 *   - Use OAuth 2.0 with the `w_member_social` scope.
 *   - Call `POST https://api.linkedin.com/v2/ugcPosts` for share content.
 */

import type {
  SocialAccountCredentials,
  SocialPostPayload,
} from "@/db/social_schema";
import type { SocialAdapter, SocialPostResult } from "./types";

const NOT_CONFIGURED =
  "LinkedIn is not yet configured. Add API credentials in Settings \u2192 Integrations.";

export const linkedinAdapter: SocialAdapter = {
  provider: "linkedin",
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
