/**
 * Adapter registry. Lookups by `SocialProvider` literal.
 */

import type { SocialProvider } from "@/db/social_schema";
import type { SocialAdapter } from "./types";
import { twitterAdapter } from "./twitter";
import { linkedinAdapter } from "./linkedin";
import { instagramAdapter } from "./instagram";

const ADAPTERS: Record<SocialProvider, SocialAdapter | null> = {
  twitter: twitterAdapter,
  linkedin: linkedinAdapter,
  instagram: instagramAdapter,
  facebook: null,
};

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
