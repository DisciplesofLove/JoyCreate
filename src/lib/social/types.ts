/**
 * Social provider adapter contract.
 *
 * Each adapter wraps the provider's REST / GraphQL surface. The handler
 * layer only ever sees `SocialAdapter` — concrete adapters can be swapped
 * (mock for tests, real for prod, federated for sovereign mode).
 */

import type {
  SocialAccountCredentials,
  SocialPostPayload,
  SocialProvider,
} from "@/db/social_schema";

export interface SocialPostResult {
  /** Canonical URL or URN of the new post. */
  externalPostId: string;
  /** Optional permalink the UI can deep-link to. */
  permalink?: string;
  /** Raw provider response for audit / debugging. */
  raw?: unknown;
}

export interface SocialAdapter {
  readonly provider: SocialProvider;

  /**
   * Trade a connect-account input for stored credentials. Real adapters
   * launch an OAuth window; the stub adapter throws a clear "not
   * configured" error so the UI can prompt the user.
   */
  connect(input: {
    /** Optional OAuth code / token shipped from the renderer. */
    authCode?: string;
    /** Free-form per-provider extras. */
    extras?: Record<string, unknown>;
  }): Promise<{
    externalId: string;
    label: string;
    credentials: SocialAccountCredentials;
  }>;

  /** Publish a post on behalf of a connected account. */
  post(
    credentials: SocialAccountCredentials,
    payload: SocialPostPayload,
  ): Promise<SocialPostResult>;
}
