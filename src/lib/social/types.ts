/**
 * Social provider adapter contract.
 *
 * Each adapter wraps the provider's REST / GraphQL surface. The handler
 * layer only ever sees `SocialAdapter` — concrete adapters can be swapped
 * (stub for not-yet-configured platforms, real for the reference platform,
 * federated for sovereign mode).
 *
 * Capability flags let the UI gracefully degrade: a provider that cannot
 * read comments simply hides the inbox affordances instead of erroring.
 */

import type {
  SocialAccountCredentials,
  SocialEngagementType,
  SocialPostPayload,
  SocialProvider,
} from "@/db/social_schema";

export interface SocialAdapterCapabilities {
  /** Can publish posts. */
  canPublish: boolean;
  /** Can fetch inbound comments / mentions / DMs. */
  canReadEngagements: boolean;
  /** Can post replies to engagements. */
  canReply: boolean;
  /** Can fetch per-post engagement metrics. */
  canMetrics: boolean;
  /** Can upload binary media (images / video). */
  canUploadMedia: boolean;
  /** Connect requires an OAuth browser round-trip. */
  oauth: boolean;
  /** Max characters per post (used by the composer counter). */
  maxTextLength: number;
  /** Supported media kinds. */
  mediaTypes: Array<"image" | "video" | "gif">;
}

export interface SocialPostResult {
  /** Canonical URL or URN of the new post. */
  externalPostId: string;
  /** Optional permalink the UI can deep-link to. */
  permalink?: string;
  /** Raw provider response for audit / debugging. */
  raw?: unknown;
}

export interface SocialConnectInput {
  /** OAuth authorization code returned to the redirect URI. */
  authCode?: string;
  /** OAuth state echoed back for CSRF validation. */
  state?: string;
  /** Redirect URI used to obtain the code (must match the auth request). */
  redirectUri?: string;
  /** Free-form per-provider extras (subreddit, page id, manual token, …). */
  extras?: Record<string, unknown>;
}

export interface SocialAuthUrl {
  /** Fully-formed authorize URL to open in a browser window. */
  url: string;
  /** Opaque state to validate on the callback. */
  state: string;
  /** Redirect URI embedded in the URL. */
  redirectUri: string;
}

export interface SocialEngagementData {
  /** Provider-side id used for de-duplication. */
  externalId: string;
  type: SocialEngagementType;
  /** External post / thread this engagement belongs to. */
  externalParentId?: string;
  authorHandle?: string;
  authorDisplayName?: string;
  text: string;
  permalink?: string;
  /** Unix-ms when created on-platform. */
  receivedAt: number;
  raw?: unknown;
}

export interface FetchEngagementsOptions {
  /** Only return engagements newer than this unix-ms timestamp. */
  sinceMs?: number;
  /** Max number to return. */
  limit?: number;
  /** Specific external post ids to inspect, when the provider needs them. */
  externalPostIds?: string[];
}

export interface SocialReplyResult {
  externalReplyId: string;
  permalink?: string;
  raw?: unknown;
}

export interface SocialMetricsData {
  impressions?: number;
  likes?: number;
  comments?: number;
  shares?: number;
  clicks?: number;
}

export interface SocialAdapter {
  readonly provider: SocialProvider;
  readonly capabilities: SocialAdapterCapabilities;

  /**
   * Build an OAuth authorize URL. Only implemented by providers whose
   * `capabilities.oauth` is true.
   */
  getAuthUrl?(input: { redirectUri: string }): Promise<SocialAuthUrl>;

  /**
   * Trade a connect-account input for stored credentials. Real adapters
   * exchange an OAuth code; stub adapters throw a clear "not configured"
   * error so the UI can prompt the user.
   */
  connect(input: SocialConnectInput): Promise<{
    externalId: string;
    label: string;
    credentials: SocialAccountCredentials;
  }>;

  /** Publish a post on behalf of a connected account. */
  post(
    credentials: SocialAccountCredentials,
    payload: SocialPostPayload,
  ): Promise<SocialPostResult>;

  /** Fetch inbound engagements (comments / mentions / DMs). */
  fetchEngagements?(
    credentials: SocialAccountCredentials,
    options: FetchEngagementsOptions,
  ): Promise<SocialEngagementData[]>;

  /** Reply to an engagement. */
  reply?(
    credentials: SocialAccountCredentials,
    engagement: { externalId: string; externalParentId?: string },
    text: string,
  ): Promise<SocialReplyResult>;

  /** Fetch metrics for a previously-published post. */
  fetchMetrics?(
    credentials: SocialAccountCredentials,
    externalPostId: string,
  ): Promise<SocialMetricsData>;
}
