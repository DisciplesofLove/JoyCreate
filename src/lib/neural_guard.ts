/**
 * Neural Guard — chokepoint middleware for side-effecting "skill" handlers.
 *
 * Every IPC handler that performs an irreversible / costly action (browser
 * automation, blockchain publish, NFT mint, file write, shell exec, HTTP
 * proxy, code execution, etc.) MUST call `assertIntent()` as the FIRST
 * line of its handler body. Without that, the handler MAY be invoked by:
 *   - a compromised renderer (XSS, malicious content)
 *   - a compromised agent process
 *   - a replay of a previously captured legitimate IPC call
 *
 * Verification chain ("Verify Then Trust"):
 *   1. Caller (renderer) builds a `SignedIntent` describing the operation:
 *        { channel, payload, agentDid, agentWallet, nonce, timestamp,
 *          signature }
 *   2. Caller signs `canonicalIntentPayload(intent)` with the agent's
 *      wallet key (preferred: unified connector; fallback: JoyWallet).
 *   3. Renderer hands the signed intent to main via IPC.
 *   4. Handler calls `assertIntent(channel, payload, signed)`.
 *   5. `verifyIntent` checks: signature recovers to `agentWallet`,
 *      timestamp within `MAX_INTENT_AGE_MS`, nonce not seen before,
 *      channel matches, payload bytes match, policy permits this
 *      `(channel, agentWallet)` combination.
 *   6. On any failure: throws — handler never executes the side effect.
 *
 * This module is isomorphic. Signing helpers (`signIntent`) are
 * renderer-only because they import wallet state from `localStorage`;
 * verification helpers (`verifyIntent`, `assertIntent`) run in main.
 *
 * Mirrors the canonical-payload pattern from `webrtc_signing.ts`.
 */

import { verifyMessage } from "ethers";
import { evaluatePolicy } from "./neural_guard_policy";

/** Reject any intent older than 60 seconds (clock skew tolerated). */
export const MAX_INTENT_AGE_MS = 60_000;

/** In-memory replay window. Promote to SQLite alongside Phase 5 audit. */
const NONCE_LRU_SIZE = 10_000;

/**
 * Rolling cache of recently-seen nonces. Map preserves insertion order so
 * we can evict the oldest entry once `NONCE_LRU_SIZE` is exceeded.
 */
const seenNonces = new Map<string, number>();

function rememberNonce(nonce: string): void {
  if (seenNonces.has(nonce)) return;
  seenNonces.set(nonce, Date.now());
  if (seenNonces.size > NONCE_LRU_SIZE) {
    const oldestKey = seenNonces.keys().next().value;
    if (oldestKey !== undefined) seenNonces.delete(oldestKey);
  }
}

/** Test-only: reset the nonce LRU. Not exported through any IPC. */
export function _resetNonceCacheForTests(): void {
  seenNonces.clear();
}

/**
 * Wire format for a signed agent intent. The renderer constructs this,
 * signs `canonicalIntentPayload(...)` with the agent's wallet, and passes
 * it as part of the IPC arguments to a guarded handler.
 *
 * `agentDid` identifies the logical agent ("acting principal"); `agentWallet`
 * identifies the EVM key that produced `signature`. They MAY be the same
 * value (when the user signs directly), or different (when an agent profile
 * is bound to a delegated key).
 */
export interface SignedIntent<P = unknown> {
  /** Exact IPC channel the caller intends to invoke (e.g. "scraper:run"). */
  channel: string;
  /** Handler-specific payload. Hashed verbatim into the canonical message. */
  payload: P;
  /** Logical agent identity. Free-form string; not cryptographically checked. */
  agentDid: string;
  /** EVM address (0x…) whose key MUST recover from `signature`. Lowercase. */
  agentWallet: string;
  /** Single-use random string. Must be unique within MAX_INTENT_AGE_MS. */
  nonce: string;
  /** ISO-8601 timestamp of intent creation. */
  timestamp: string;
  /** EIP-191 personal_sign signature over `canonicalIntentPayload(this)`. */
  signature: string;
}

/**
 * Stable, sorted-key JSON of the intent. The `signature` field is excluded;
 * everything else that affects meaning MUST be present so that any tamper
 * (channel swap, payload mutation, replay window stretch) breaks the hash.
 */
export function canonicalIntentPayload<P>(intent: SignedIntent<P>): string {
  const fields: Record<string, unknown> = {
    agentDid: intent.agentDid,
    agentWallet: (intent.agentWallet ?? "").toLowerCase(),
    channel: intent.channel,
    nonce: intent.nonce,
    payload: intent.payload ?? null,
    timestamp: intent.timestamp,
  };
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(fields).sort()) sorted[k] = fields[k];
  return JSON.stringify(sorted);
}

export interface VerifyIntentResult {
  ok: boolean;
  /** Recovered EVM address, lowercased. Present even on failure when known. */
  recovered?: string;
  /** Reason when `ok` is false. Suitable for logs; not for user display. */
  reason?: string;
}

/**
 * Verify a signed intent against the channel + payload the handler actually
 * received. Returns `{ ok: true }` only when EVERY check passes:
 *   - `signed.channel` equals `expectedChannel` (no cross-channel reuse)
 *   - canonical bytes of `signed.payload` equal those of `expectedPayload`
 *   - `signed.timestamp` is within `MAX_INTENT_AGE_MS` of now
 *   - `signed.nonce` has not been seen before in this process
 *   - signature recovers to `signed.agentWallet`
 *
 * Successful verification has the side effect of recording the nonce so a
 * second call with the same nonce will be rejected.
 */
export function verifyIntent<P>(
  expectedChannel: string,
  expectedPayload: P,
  signed: SignedIntent<P> | null | undefined,
): VerifyIntentResult {
  if (!signed) return { ok: false, reason: "missing signed intent" };
  if (!signed.signature) return { ok: false, reason: "missing signature" };
  if (!signed.agentWallet) return { ok: false, reason: "missing agentWallet" };
  if (!signed.nonce) return { ok: false, reason: "missing nonce" };

  if (signed.channel !== expectedChannel) {
    return {
      ok: false,
      reason: `channel mismatch: signed=${signed.channel} expected=${expectedChannel}`,
    };
  }

  // Canonical compare avoids JSON-key-order false negatives.
  const canonicalSigned = JSON.stringify(stableSort(signed.payload));
  const canonicalExpected = JSON.stringify(stableSort(expectedPayload));
  if (canonicalSigned !== canonicalExpected) {
    return { ok: false, reason: "payload hash mismatch" };
  }

  const ts = Date.parse(signed.timestamp);
  if (Number.isNaN(ts)) return { ok: false, reason: "invalid timestamp" };
  const age = Math.abs(Date.now() - ts);
  if (age > MAX_INTENT_AGE_MS) {
    return { ok: false, reason: `timestamp drift ${age}ms` };
  }

  if (seenNonces.has(signed.nonce)) {
    return { ok: false, reason: "nonce replay" };
  }

  let recovered: string;
  try {
    recovered = verifyMessage(
      canonicalIntentPayload(signed),
      signed.signature,
    ).toLowerCase();
  } catch (err) {
    return {
      ok: false,
      reason: `signature recover failed: ${(err as Error).message}`,
    };
  }

  if (recovered !== signed.agentWallet.toLowerCase()) {
    return {
      ok: false,
      recovered,
      reason: `signer ${recovered} ≠ agentWallet ${signed.agentWallet.toLowerCase()}`,
    };
  }

  // Commit nonce only after every other check has passed so that a tampered
  // intent cannot burn a legitimate nonce.
  rememberNonce(signed.nonce);
  return { ok: true, recovered };
}

/**
 * Throw-on-deny convenience for handlers. Also runs the policy check from
 * `neural_guard_policy.ts` if a policy is configured for this channel.
 *
 * @throws Error("neural-guard: <reason>") when verification or policy denies.
 */
export function assertIntent<P>(
  channel: string,
  payload: P,
  signed: SignedIntent<P> | null | undefined,
): void {
  const verify = verifyIntent(channel, payload, signed);
  if (!verify.ok) {
    throw new Error(`neural-guard: ${verify.reason ?? "verification failed"}`);
  }
  const policy = evaluatePolicy(channel, signed?.agentWallet);
  if (!policy.ok) {
    throw new Error(`neural-guard: ${policy.reason ?? "policy denied"}`);
  }
}

/**
 * Wrapper shape for guarded IPC calls. Renderer-side helpers in
 * `IpcClient.signAndInvoke` and `useGuardedMutation` produce this object
 * automatically: `{ payload, signedIntent }`.
 */
export interface GuardedArgs<P> {
  payload: P;
  signedIntent: SignedIntent<P>;
}

/**
 * Handler-side adapter. Accepts EITHER a `GuardedArgs<P>` (verified +
 * payload returned) OR a legacy raw payload (warned about and returned as-is
 * unless `JOY_NEURAL_GUARD_ENFORCE=1`).
 *
 * Use as the FIRST line of every guarded handler:
 *
 *   ipcMain.handle("scraper:run", async (_event, args) => {
 *     const params = unwrapGuarded<ScrapeParams>("scraper:run", args);
 *     // … rest of handler ignores guard plumbing entirely.
 *   });
 *
 * Once every renderer caller has migrated to `signAndInvoke`, set
 * `JOY_NEURAL_GUARD_ENFORCE=1` (or flip `setDefaultAction("deny")`) so any
 * remaining unsigned call throws.
 */
export function unwrapGuarded<P>(
  channel: string,
  args: unknown,
): P {
  if (
    args !== null &&
    typeof args === "object" &&
    "payload" in (args as Record<string, unknown>) &&
    "signedIntent" in (args as Record<string, unknown>)
  ) {
    const wrapped = args as GuardedArgs<P>;
    assertIntent(channel, wrapped.payload, wrapped.signedIntent);
    return wrapped.payload;
  }

  if (process.env.JOY_NEURAL_GUARD_ENFORCE === "1") {
    throw new Error(
      `neural-guard: refused unsigned legacy call to ${channel} (enforce=1)`,
    );
  }
  // Soft-fail during rollout: log once per channel, then proceed.
  warnOnceLegacyCall(channel);
  return args as P;
}

const _legacyWarned = new Set<string>();
function warnOnceLegacyCall(channel: string): void {
  if (_legacyWarned.has(channel)) return;
  _legacyWarned.add(channel);
  // eslint-disable-next-line no-console
  console.warn(
    `[neural-guard] unsigned legacy call to ${channel} — migrate caller to IpcClient.signAndInvoke / useGuardedMutation`,
  );
}

/** Test-only reset of the legacy-warning de-dupe set. */
export function _resetLegacyWarnedForTests(): void {
  _legacyWarned.clear();
}

// ── canonicalisation helpers ────────────────────────────────────────────────

/**
 * Recursively reorder object keys so that `JSON.stringify` produces the
 * same bytes regardless of property insertion order. Arrays preserve
 * their index order. Non-plain values pass through unchanged.
 */
function stableSort(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(stableSort);
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(obj).sort()) out[k] = stableSort(obj[k]);
  return out;
}

// ── renderer-side signer (intentionally last so server-side verify code
//    above can be tree-shaken into the main bundle without pulling these in
//    when they're unused) ─────────────────────────────────────────────────

/**
 * Build + sign an intent on the renderer side. Returns a `SignedIntent`
 * ready to ship over IPC.
 *
 * Tries the unified wallet connector first (Privy / MetaMask / WalletConnect
 * / Coinbase). Falls back to the built-in `joy_wallet.signMessage` when no
 * external wallet is connected.
 *
 * @throws when no wallet is available (caller should prompt the user to
 *   create or connect one before invoking a guarded skill).
 */
export async function signIntent<P>(
  channel: string,
  payload: P,
  options: { agentDid?: string; agentWallet?: string } = {},
): Promise<SignedIntent<P>> {
  // Lazy imports keep this module importable from the main process where
  // `joy_wallet` (which touches `localStorage`) cannot load.
  const [{ getCurrentWallet, getEthersSigner }, joyWallet] = await Promise.all([
    import("./wallet/joy_wallet_connector"),
    import("./joy_wallet"),
  ]);

  const fallbackAddress = joyWallet.getStoredAddress();
  const agentWallet = (
    options.agentWallet ??
    fallbackAddress ??
    ""
  ).toLowerCase();
  if (!agentWallet) {
    throw new Error(
      "neural-guard: no wallet available to sign intent (create or connect one first)",
    );
  }

  const intent: SignedIntent<P> = {
    channel,
    payload,
    agentDid: options.agentDid ?? agentWallet,
    agentWallet,
    nonce: cryptoRandomNonce(),
    timestamp: new Date().toISOString(),
    signature: "",
  };
  const message = canonicalIntentPayload(intent);

  const connector = getCurrentWallet();
  if (connector) {
    const signer = await getEthersSigner();
    if (signer) {
      const signature = await signer.signMessage(message);
      return { ...intent, signature };
    }
  }
  const signature = await joyWallet.signMessage(message);
  return { ...intent, signature };
}

function cryptoRandomNonce(): string {
  const bytes = new Uint8Array(16);
  // `crypto` is available in both renderer (window.crypto) and modern Node.
  crypto.getRandomValues(bytes);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}
