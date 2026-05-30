/**
 * Verifiable-inference attestation layer — provider-agnostic config.
 *
 * The marketplace pipeline (Agent → X402 → inference → ValidationRegistry →
 * EditionController mint) only needs a *verifiable attestation* that a given
 * inference ran. WHERE that proof comes from is pluggable:
 *
 *   - "local"      → dev stub, $0, no on-chain write (demos without spend)
 *   - "optimistic" → validator signs (inputHash|outputHash|modelId) + stakes;
 *                    ~$0 recurring (gas only). The right Web 4.0 default.
 *   - "lit"        → Lit Action runs the hash + PKP threshold-signs the result
 *                    across Lit's TEE-backed node set. Pay-per-use, no idle cost.
 *   - "nitro"      → hardware TEE quote (stub; fill when a buyer demands it).
 *
 * No always-on enclave is required. Default is "local" so the stack is fully
 * functional and costs nothing until a real provider is configured via env.
 */

export type TeeMode = "local" | "optimistic" | "lit" | "nitro";

export const TEE_MODES: readonly TeeMode[] = ["local", "optimistic", "lit", "nitro"];

/** Attestation envelope version (bump on breaking schema changes). */
export const ATTESTATION_VERSION = "joy-tee/1.0" as const;

/**
 * Resolve the active TEE mode from env, defaulting to the zero-cost local stub.
 * Set JOY_TEE_MODE=optimistic|lit|nitro to switch providers.
 */
export function resolveTeeMode(): TeeMode {
  const raw = (process.env.JOY_TEE_MODE ?? "").trim().toLowerCase();
  if ((TEE_MODES as readonly string[]).includes(raw)) {
    return raw as TeeMode;
  }
  return "local";
}

/** Lit Protocol configuration (only required when mode === "lit"). */
export interface LitConfig {
  /** Lit network, e.g. "datil-dev" | "datil-test" | "datil". */
  network: string;
  /** PKP public key used to threshold-sign attestations. */
  pkpPublicKey: string;
  /** Optional Lit Action IPFS CID; when absent, an inline action is used. */
  actionCid?: string;
}

export function resolveLitConfig(): LitConfig | null {
  const network = process.env.JOY_LIT_NETWORK?.trim();
  const pkpPublicKey = process.env.JOY_LIT_PKP_PUBKEY?.trim();
  if (!network || !pkpPublicKey) return null;
  return {
    network,
    pkpPublicKey,
    actionCid: process.env.JOY_LIT_ACTION_CID?.trim() || undefined,
  };
}

/** Nitro (or other hardware TEE) endpoint config (only required for "nitro"). */
export interface NitroConfig {
  /** Attestation gateway URL that returns a signed quote for a payload. */
  endpoint: string;
  /** Optional bearer token for the gateway. */
  apiKey?: string;
}

export function resolveNitroConfig(): NitroConfig | null {
  const endpoint = process.env.JOY_NITRO_ENDPOINT?.trim();
  if (!endpoint) return null;
  return { endpoint, apiKey: process.env.JOY_NITRO_API_KEY?.trim() || undefined };
}

/**
 * Whether the resolved mode is ready to run.
 * - local / optimistic are always ready (no external creds).
 * - lit / nitro require their respective env config.
 */
export function isTeeReady(mode: TeeMode = resolveTeeMode()): boolean {
  switch (mode) {
    case "local":
    case "optimistic":
      return true;
    case "lit":
      return resolveLitConfig() !== null;
    case "nitro":
      return resolveNitroConfig() !== null;
    default:
      return false;
  }
}

/** Map a TEE mode to the proof artifact kind it produces. */
export function proofKindForMode(mode: TeeMode): AttestationProofKind {
  switch (mode) {
    case "local":
      return "local-digest";
    case "optimistic":
      return "stake-signature";
    case "lit":
      return "lit-pkp-signature";
    case "nitro":
      return "tee-quote";
  }
}

export type AttestationProofKind =
  | "local-digest"
  | "stake-signature"
  | "lit-pkp-signature"
  | "tee-quote";
