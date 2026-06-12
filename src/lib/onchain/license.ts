/**
 * LR2 — Structured License Terms.
 *
 * The "licensing" half of a Licensed Runtime Asset. A `LicenseTerms` object is
 * pinned alongside drop metadata, hash-committed into that metadata, exposed as
 * a `license` node on the ERC-1144 blueprint, and enforced at purchase / runtime
 * time via `checkLicense`.
 *
 * Kept deliberately small and additive: unknown fields are ignored by older
 * consumers, and a legacy SPDX string maps cleanly onto a `LicenseTerms` via
 * `normalizeLicense`.
 */

import { ethers } from "ethers";

/** Current license-terms schema version. */
export const LICENSE_TERMS_VERSION = "joy-license/1.0";

/** Default license id when none is supplied (permissive, no commercial). */
export const DEFAULT_LICENSE_ID = "joy/cc-by/1.0";

/** A use a consumer may request authorization for. */
export type LicenseUse = "commercial" | "derivative" | "runtimeExecution";

export interface LicenseTerms {
  /** Schema discriminator. */
  schema: string;
  /** License identifier (e.g. "joy/commercial-runtime/1.0"). */
  id: string;
  /** Optional SPDX id for human-readable licenses ("CC-BY-4.0", "MIT"). */
  spdx: string | null;
  /** Commercial use allowed. */
  commercial: boolean;
  /** Derivative works allowed. */
  derivative: boolean;
  /** Buyer may execute the asset's skillCID locally (bridge to LR8 runtime). */
  runtimeExecution: boolean;
  /** ISO expiry timestamp, or null for perpetual. */
  expiry: string | null;
  /** Per-mint seat count, or null for unlimited. */
  seats: number | null;
  /** Optional ipfs:// pointer to full legal text. */
  termsUri: string | null;
}

export interface BuildLicenseTermsInput {
  id?: string;
  spdx?: string | null;
  commercial?: boolean;
  derivative?: boolean;
  runtimeExecution?: boolean;
  expiry?: string | null;
  seats?: number | null;
  termsUri?: string | null;
}

/** Build a `LicenseTerms` from partial input (pure — no I/O). */
export function buildLicenseTerms(input: BuildLicenseTermsInput = {}): LicenseTerms {
  return {
    schema: LICENSE_TERMS_VERSION,
    id: input.id ?? DEFAULT_LICENSE_ID,
    spdx: input.spdx ?? null,
    commercial: input.commercial ?? false,
    derivative: input.derivative ?? false,
    runtimeExecution: input.runtimeExecution ?? false,
    expiry: input.expiry ?? null,
    seats: input.seats ?? null,
    termsUri: input.termsUri ?? null,
  };
}

/**
 * Coerce a legacy license source into structured terms. Accepts:
 *   - an existing `LicenseTerms` object (returned as-is),
 *   - a plain SPDX string (mapped to `spdx`, with a derived id),
 *   - `undefined` (the permissive default).
 */
export function normalizeLicense(
  source: string | LicenseTerms | undefined | null,
): LicenseTerms {
  if (source && typeof source === "object") return source;
  if (typeof source === "string" && source.trim()) {
    const spdx = source.trim();
    return buildLicenseTerms({
      id: `spdx/${spdx.toLowerCase()}`,
      spdx,
    });
  }
  return buildLicenseTerms();
}

export interface LicenseCheckResult {
  allowed: boolean;
  reason?: string;
}

/**
 * Decide whether `use` is permitted under `terms` at `now`. Expiry is enforced
 * for every use. Returns a structured result (callers throw/deny as needed).
 */
export function checkLicense(
  terms: LicenseTerms,
  use: LicenseUse,
  now: Date = new Date(),
): LicenseCheckResult {
  if (terms.expiry) {
    const expiresAt = Date.parse(terms.expiry);
    if (Number.isFinite(expiresAt) && now.getTime() > expiresAt) {
      return { allowed: false, reason: `license expired at ${terms.expiry}` };
    }
  }
  switch (use) {
    case "commercial":
      return terms.commercial
        ? { allowed: true }
        : { allowed: false, reason: "license does not permit commercial use" };
    case "derivative":
      return terms.derivative
        ? { allowed: true }
        : { allowed: false, reason: "license does not permit derivative works" };
    case "runtimeExecution":
      return terms.runtimeExecution
        ? { allowed: true }
        : { allowed: false, reason: "license does not permit runtime execution" };
    default:
      return { allowed: false, reason: `unknown license use: ${use as string}` };
  }
}

/**
 * Deterministic keccak256 over the canonical (sorted-key) license JSON. Committed
 * into drop metadata so the pinned terms are tamper-evident.
 */
export function hashLicenseTerms(terms: LicenseTerms): string {
  const canonical = JSON.stringify(terms, Object.keys(terms).sort());
  return ethers.keccak256(ethers.toUtf8Bytes(canonical));
}
