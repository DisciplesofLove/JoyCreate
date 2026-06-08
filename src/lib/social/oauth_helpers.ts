/**
 * Shared OAuth2 helpers for social adapters.
 *
 * Providers that use the Authorization-Code flow (with or without PKCE) share
 * the same shape: build an authorize URL with an opaque `state`, then exchange
 * the returned `code` for tokens. PKCE additionally requires a `code_verifier`
 * generated alongside the URL and replayed at exchange time.
 *
 * Because `getAuthUrl` and `connect` are two separate adapter calls, anything
 * generated in the first step (PKCE verifier, redirect URI) is stashed in a
 * short-lived in-memory store keyed by `state` and reclaimed during `connect`.
 * The whole flow happens within one app session and within the OAuth timeout,
 * so a process-memory store is sufficient and avoids persisting verifiers.
 */

import { createHash, randomBytes } from "node:crypto";

export interface PendingAuth {
  redirectUri: string;
  codeVerifier?: string;
  /** Wall-clock ms when this entry was created (for GC). */
  createdAt: number;
}

const PENDING_TTL_MS = 10 * 60 * 1000;

/** Per-provider pending-auth store keyed by OAuth `state`. */
export class PendingAuthStore {
  private readonly map = new Map<string, PendingAuth>();

  remember(state: string, data: Omit<PendingAuth, "createdAt">): void {
    this.gc();
    this.map.set(state, { ...data, createdAt: Date.now() });
  }

  take(state: string): PendingAuth | undefined {
    const entry = this.map.get(state);
    if (entry) this.map.delete(state);
    return entry;
  }

  private gc(): void {
    const cutoff = Date.now() - PENDING_TTL_MS;
    for (const [key, value] of this.map) {
      if (value.createdAt < cutoff) this.map.delete(key);
    }
  }
}

/** Cryptographically-random opaque state for CSRF protection. */
export function randomState(): string {
  return randomBytes(16).toString("hex");
}

export interface PkcePair {
  verifier: string;
  challenge: string;
  method: "S256";
}

/** Generate a PKCE verifier/challenge pair (RFC 7636, S256). */
export function generatePkce(): PkcePair {
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge, method: "S256" };
}

function base64Url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
