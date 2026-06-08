/**
 * Social credential store.
 *
 * Persists two kinds of secrets outside the SQLite database:
 *   1. Per-account OAuth token bundles (access / refresh tokens).
 *   2. Per-provider OAuth *app* credentials (client id / secret / redirect).
 *
 * Secrets are encrypted at rest with Electron's `safeStorage` (the same
 * mechanism the BYOK settings use) and written under
 * `userData/social-credentials`. This keeps tokens available to the main
 * process for autonomous, scheduled posting without an interactive vault
 * unlock, while never storing raw tokens in the DB (the DB only references a
 * `vaultSecretId`).
 *
 * If OS-level encryption is unavailable (e.g. headless Linux without a
 * keyring) the store falls back to base64 with a `plaintext` marker, mirroring
 * the settings module's behaviour.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { app, safeStorage } from "electron";
import log from "electron-log";

const logger = log.scope("social_credentials");

export interface SocialTokenBundle {
  accessToken: string;
  refreshToken?: string;
  /** Token expiry, ms epoch. */
  expiresAt?: number;
  /** Granted scopes. */
  scopes?: string[];
  /** Any provider-specific extras needed for refresh. */
  [key: string]: unknown;
}

export interface SocialAppCredentials {
  clientId: string;
  clientSecret?: string;
  /** Redirect URI registered with the provider's OAuth app. */
  redirectUri?: string;
}

const ENV_FALLBACK: Record<string, (key: string) => string | undefined> = {
  reddit: (key) => process.env[`REDDIT_${key}`],
  twitter: (key) => process.env[`TWITTER_${key}`],
  linkedin: (key) => process.env[`LINKEDIN_${key}`],
  facebook: (key) => process.env[`FACEBOOK_${key}`],
  instagram: (key) => process.env[`INSTAGRAM_${key}`],
};

function baseDir(): string {
  const dir = path.join(app.getPath("userData"), "social-credentials");
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, "apps"), { recursive: true });
  fs.mkdirSync(path.join(dir, "tokens"), { recursive: true });
  return dir;
}

/** Filesystem-safe id for a vault key. */
function sanitize(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function encryptToDisk(filePath: string, plaintext: string): void {
  try {
    if (safeStorage.isEncryptionAvailable()) {
      const buf = safeStorage.encryptString(plaintext);
      fs.writeFileSync(filePath, buf);
      return;
    }
  } catch (err) {
    logger.warn("safeStorage encrypt failed, falling back to plaintext", err);
  }
  // Fallback: tag with a sentinel so we know it isn't encrypted.
  fs.writeFileSync(filePath, `plaintext:${Buffer.from(plaintext).toString("base64")}`);
}

function decryptFromDisk(filePath: string): string | null {
  if (!fs.existsSync(filePath)) return null;
  const raw = fs.readFileSync(filePath);
  const asText = raw.toString("utf8");
  if (asText.startsWith("plaintext:")) {
    return Buffer.from(asText.slice("plaintext:".length), "base64").toString("utf8");
  }
  try {
    return safeStorage.decryptString(raw);
  } catch (err) {
    logger.error("safeStorage decrypt failed", err);
    return null;
  }
}

// ── Per-account OAuth tokens ─────────────────────────────────────────────

/**
 * Persist a token bundle and return its stable vault secret id. The id is
 * derived from provider + externalId so reconnecting the same account
 * overwrites the prior tokens.
 */
export function saveTokens(
  provider: string,
  externalId: string,
  tokens: SocialTokenBundle,
): string {
  const secretId = `${provider}:${externalId}`;
  const file = path.join(baseDir(), "tokens", `${sanitize(secretId)}.bin`);
  encryptToDisk(file, JSON.stringify(tokens));
  return secretId;
}

export function loadTokens(vaultSecretId: string): SocialTokenBundle | null {
  const file = path.join(baseDir(), "tokens", `${sanitize(vaultSecretId)}.bin`);
  const text = decryptFromDisk(file);
  if (!text) return null;
  try {
    return JSON.parse(text) as SocialTokenBundle;
  } catch {
    return null;
  }
}

/** Overwrite the bundle at an existing secret id (used after token refresh). */
export function updateTokens(
  vaultSecretId: string,
  tokens: SocialTokenBundle,
): void {
  const file = path.join(baseDir(), "tokens", `${sanitize(vaultSecretId)}.bin`);
  encryptToDisk(file, JSON.stringify(tokens));
}

export function deleteTokens(vaultSecretId: string): void {
  const file = path.join(baseDir(), "tokens", `${sanitize(vaultSecretId)}.bin`);
  try {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch (err) {
    logger.warn(`failed to delete tokens for ${vaultSecretId}`, err);
  }
}

// ── Per-provider OAuth app credentials ───────────────────────────────────

export function setAppCredentials(
  provider: string,
  creds: SocialAppCredentials,
): void {
  const file = path.join(baseDir(), "apps", `${sanitize(provider)}.bin`);
  encryptToDisk(file, JSON.stringify(creds));
}

export function getAppCredentials(
  provider: string,
): SocialAppCredentials | null {
  const file = path.join(baseDir(), "apps", `${sanitize(provider)}.bin`);
  const text = decryptFromDisk(file);
  if (text) {
    try {
      return JSON.parse(text) as SocialAppCredentials;
    } catch {
      /* fall through to env */
    }
  }
  const env = ENV_FALLBACK[provider];
  if (env) {
    const clientId = env("CLIENT_ID");
    if (clientId) {
      return {
        clientId,
        clientSecret: env("CLIENT_SECRET"),
        redirectUri: env("REDIRECT_URI"),
      };
    }
  }
  return null;
}

export function hasAppCredentials(provider: string): boolean {
  return getAppCredentials(provider) !== null;
}
