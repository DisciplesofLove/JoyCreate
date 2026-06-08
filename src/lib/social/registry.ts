/**
 * Adapter registry. Lookups by `SocialProvider` literal.
 */

import type { SocialProvider } from "@/db/social_schema";
import { hasAppCredentials } from "./credentials";
import { facebookAdapter } from "./facebook";
import { instagramAdapter } from "./instagram";
import { linkedinAdapter } from "./linkedin";
import { redditAdapter } from "./reddit";
import { twitterAdapter } from "./twitter";
import type { SocialAdapter, SocialAdapterCapabilities } from "./types";

const ADAPTERS: Record<SocialProvider, SocialAdapter | null> = {
  twitter: twitterAdapter,
  linkedin: linkedinAdapter,
  instagram: instagramAdapter,
  facebook: facebookAdapter,
  reddit: redditAdapter,
};

/**
 * Providers that are fully implemented end-to-end (real OAuth + publish, and —
 * where the platform's API tier allows — engagement + metrics). Each connects
 * via real OAuth once the user supplies their app credentials.
 */
const FULLY_IMPLEMENTED: ReadonlySet<SocialProvider> = new Set([
  "reddit",
  "twitter",
  "linkedin",
  "facebook",
  "instagram",
]);

export interface SocialProviderInfo {
  provider: SocialProvider;
  capabilities: SocialAdapterCapabilities;
  /** True when the adapter is fully implemented. */
  implemented: boolean;
  /** True when the user has supplied OAuth app credentials for it. */
  configured: boolean;
}

export function getSocialAdapter(provider: SocialProvider): SocialAdapter {
  const adapter = ADAPTERS[provider];
  if (!adapter) {
    throw new Error(`No adapter registered for provider "${provider}".`);
  }
  return adapter;
}

export function listSupportedProviders(): SocialProvider[] {
  return (Object.keys(ADAPTERS) as SocialProvider[]).filter(
    (p) => ADAPTERS[p] !== null,
  );
}

/** Rich provider catalogue for the UI (capabilities + readiness flags). */
export function listProviderInfo(): SocialProviderInfo[] {
  return listSupportedProviders().map((provider) => {
    const adapter = getSocialAdapter(provider);
    return {
      provider,
      capabilities: adapter.capabilities,
      implemented: FULLY_IMPLEMENTED.has(provider),
      configured: hasAppCredentials(provider),
    };
  });
}

export function getProviderCapabilities(
  provider: SocialProvider,
): SocialAdapterCapabilities {
  return getSocialAdapter(provider).capabilities;
}
