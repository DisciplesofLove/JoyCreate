/**
 * Joy Marketplace wallet-auth session.
 *
 * `lit-chipotle` and `ipfs-upload` both run behind `guardRequest({ auth:
 * "required" })`, which rejects anonymous callers with 401. The browser gets a
 * session from Privy; a headless publisher gets one the same way the
 * marketplace's own `scripts/publish-asset.mjs` does — sign a server-issued
 * nonce with the chain wallet, exchange the signature for a magic-link token
 * hash, and redeem that for a real Supabase session.
 *
 * Mirrors `scripts/publish-asset.mjs::walletAuthSession()` step for step. The
 * session is cached per wallet address for the process lifetime; Supabase
 * access tokens are an hour long and a publish run is minutes, so no refresh
 * loop is needed — but `clearSession` exists so a failed publish can force a
 * fresh handshake rather than retry with a token that may have expired.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { ethers } from "ethers";
import log from "electron-log";

import { JOYMARKETPLACE_API } from "@/config/joymarketplace";

const logger = log.scope("marketplace_session");

const SUPABASE_URL = JOYMARKETPLACE_API.supabaseUrl;
const SUPABASE_ANON_KEY = JOYMARKETPLACE_API.supabaseAnonKey;

export interface MarketplaceSession {
  /** Supabase user access token — the bearer for authenticated edge functions. */
  accessToken: string;
  /** Signed-in Supabase client, for callers that prefer `functions.invoke`. */
  client: SupabaseClient;
  /** Wallet address the session is bound to. */
  address: string;
}

/** address (lowercased) -> live session */
const sessions = new Map<string, MarketplaceSession>();

async function walletAuthCall(body: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/wallet-auth`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      apikey: SUPABASE_ANON_KEY,
      authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      `wallet-auth ${String(body.action)} failed: ${json?.error ?? res.status}`,
    );
  }
  return json;
}

/**
 * Establish (or reuse) an authenticated marketplace session for `wallet`.
 *
 * Throws on failure — every downstream step needs the token, so a soft failure
 * here would only surface later as a confusing 401 from a different function.
 */
export async function getMarketplaceSession(
  wallet: ethers.Wallet,
): Promise<MarketplaceSession> {
  const address = wallet.address;
  const cached = sessions.get(address.toLowerCase());
  if (cached) return cached;

  const { message } = await walletAuthCall({ action: "nonce", address });
  if (typeof message !== "string" || message.length === 0) {
    throw new Error("wallet-auth nonce returned no message to sign");
  }

  const signature = await wallet.signMessage(message);

  const { token_hash } = await walletAuthCall({
    action: "verify",
    address,
    signature,
    message,
  });
  if (typeof token_hash !== "string" || token_hash.length === 0) {
    throw new Error("wallet-auth verify returned no token_hash");
  }

  const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data, error } = await client.auth.verifyOtp({
    type: "magiclink",
    token_hash,
  });
  if (error || !data?.session) {
    throw new Error(`verifyOtp failed: ${error?.message ?? "no session returned"}`);
  }

  await client.auth.setSession({
    access_token: data.session.access_token,
    refresh_token: data.session.refresh_token,
  });

  const session: MarketplaceSession = {
    accessToken: data.session.access_token,
    client,
    address,
  };
  sessions.set(address.toLowerCase(), session);
  logger.info(`marketplace session established for ${address}`);
  return session;
}

/** Drop the cached session for `address` so the next call re-handshakes. */
export function clearMarketplaceSession(address: string): void {
  sessions.delete(address.toLowerCase());
}
