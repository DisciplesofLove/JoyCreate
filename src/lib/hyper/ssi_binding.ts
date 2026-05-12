/**
 * Hyper ↔ SSI binding (Phase 5).
 *
 * Resolves the active primary `did:joy` identity from `ssi_identities` so
 * the HyperService can stamp every joined topic / outgoing handshake with
 * the operator's DID. Peers can then verify "this hypercore device key
 * really belongs to DID X" before granting topic access.
 *
 * NOTE: We deliberately do NOT use the SSI private key as the swarm noise
 * keypair — corestore already manages a stable per-device noise key, and
 * mixing the two would conflate identity-key compromise with transport-key
 * compromise. Instead this module returns the *public* DID + the device
 * keypair fingerprint, which the auth challenge layer will sign over.
 */

import log from "electron-log";
import { db } from "@/db";
import { ssiIdentities } from "@/db/schema";
import { and, eq } from "drizzle-orm";

const logger = log.scope("hyper_ssi_binding");

export interface HyperIdentityBinding {
  /** Primary DID (e.g. "did:joy:abcd..."). null when no identity exists. */
  did: string | null;
  /** Hex-encoded ed25519 public key associated with the DID. null when none. */
  publicKeyHex: string | null;
  /** Identity algorithm — "ed25519" or "secp256k1". null when none. */
  algorithm: "ed25519" | "secp256k1" | null;
}

let cached: HyperIdentityBinding | null = null;

/**
 * Resolve the operator's primary SSI identity. Returns `{did:null}` when
 * no identity has been provisioned yet (first-launch / pre-onboarding).
 *
 * Cached after first successful read; call {@link invalidateBinding} after
 * key rotation.
 */
export async function resolveHyperIdentity(): Promise<HyperIdentityBinding> {
  if (cached) return cached;
  try {
    const row = await db.query.ssiIdentities.findFirst({
      where: and(
        eq(ssiIdentities.identityType, "primary"),
        eq(ssiIdentities.active, true),
      ),
    });
    cached = {
      did: row?.did ?? null,
      publicKeyHex: row?.publicKey ?? null,
      algorithm: (row?.algorithm ?? null) as HyperIdentityBinding["algorithm"],
    };
    if (cached.did) {
      logger.info(
        `Bound hyper to SSI identity ${cached.did.slice(0, 24)}… (${cached.algorithm})`,
      );
    } else {
      logger.warn("No primary SSI identity found — hyper running unbound");
    }
    return cached;
  } catch (err) {
    logger.warn("resolveHyperIdentity failed", err);
    cached = { did: null, publicKeyHex: null, algorithm: null };
    return cached;
  }
}

export function invalidateBinding(): void {
  cached = null;
}
