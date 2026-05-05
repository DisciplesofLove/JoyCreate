/**
 * WebRTC signaling signature helpers.
 *
 * Every WebRTC signaling message carries a `signature` field that proves
 * the sender owns the wallet listed in `fromWallet`. Without this, any
 * peer on the chat transport can spoof offers / ICE candidates and either
 * MITM the call or DoS by pumping bogus candidates.
 *
 * Signing strategy:
 *   1. Build a canonical, sorted-key JSON of every relayable field of
 *      the signal EXCEPT `signature` itself.
 *   2. Sign with whichever wallet is currently active:
 *        a. The unified connector (`getEthersSigner()`) — Privy /
 *           MetaMask / Coinbase / Rainbow / WalletConnect.
 *        b. Fall back to the built-in JoyWallet (`signMessage`).
 *   3. Verify with `ethers.verifyMessage` and compare to `fromWallet`
 *      (case-insensitive, EVM addresses are case-insensitive).
 *
 * The signing payload is intentionally narrow: SDP / ICE candidate /
 * timestamp / nonce / from / to / conversationId. Replays are bounded
 * by `timestamp` (must be within MAX_SIGNAL_AGE_MS) and by `nonce`
 * uniqueness over the signaling channel.
 */

import { verifyMessage } from "ethers";
import {
  getCurrentWallet,
  getEthersSigner,
} from "./wallet/joy_wallet_connector";
import { signMessage as joyWalletSign } from "./joy_wallet";
import type { WebRTCSignal } from "@/types/webrtc_types";

/** Reject any signal older than 60 seconds (clock skew tolerated). */
export const MAX_SIGNAL_AGE_MS = 60_000;

/**
 * Canonical signing payload — stable JSON with sorted keys. The
 * `signature` field is excluded; everything else that affects the
 * meaning of the message MUST be included.
 */
export function canonicalSignalPayload(signal: WebRTCSignal): string {
  const candidate = signal.candidate
    ? {
        candidate: signal.candidate.candidate ?? "",
        sdpMid: signal.candidate.sdpMid ?? null,
        sdpMLineIndex: signal.candidate.sdpMLineIndex ?? null,
      }
    : null;

  const payload = {
    callType: signal.callType ?? null,
    candidate,
    conversationId: signal.conversationId ?? null,
    from: signal.from,
    fromWallet: signal.fromWallet,
    id: signal.id,
    nonce: signal.nonce,
    sdp: signal.sdp ?? null,
    sdpType: signal.sdpType ?? null,
    timestamp: signal.timestamp,
    to: signal.to,
    toWallet: signal.toWallet,
    type: signal.type,
  };

  // Object key order is fixed by the literal above, so JSON.stringify
  // is already canonical. We still alphabetise via Object.keys to defend
  // against future field reordering by a code formatter.
  const keys = Object.keys(payload).sort();
  const sorted: Record<string, unknown> = {};
  for (const k of keys) sorted[k] = (payload as Record<string, unknown>)[k];
  return JSON.stringify(sorted);
}

/**
 * Sign a WebRTC signal. Throws if no wallet is connected.
 *
 * Returns a NEW signal object with `signature` set; the input is not
 * mutated.
 */
export async function signSignal(
  signal: WebRTCSignal,
): Promise<WebRTCSignal> {
  const message = canonicalSignalPayload({ ...signal, signature: "" });

  // Prefer the unified connector (whatever wallet the user just picked).
  const connector = getCurrentWallet();
  if (connector) {
    const signer = await getEthersSigner();
    if (signer) {
      const signature = await signer.signMessage(message);
      return { ...signal, signature };
    }
  }

  // Fall back to the built-in JoyWallet. signMessage() uses the
  // unencrypted in-memory key when no password is set.
  const signature = await joyWalletSign(message);
  return { ...signal, signature };
}

export interface VerifyResult {
  ok: boolean;
  /** Recovered EVM address, lowercased. */
  recovered?: string;
  /** Reason when `ok` is false. */
  reason?: string;
}

/**
 * Verify the signature on a WebRTC signal.
 *
 * Returns `{ ok: true, recovered }` if the signature recovers to the
 * `fromWallet` address AND the timestamp is within MAX_SIGNAL_AGE_MS.
 * Otherwise returns `{ ok: false, reason }`.
 *
 * Callers MUST drop signals that fail verification — never feed an
 * unverified SDP / ICE candidate into RTCPeerConnection.
 */
export function verifySignal(signal: WebRTCSignal): VerifyResult {
  if (!signal.signature) {
    return { ok: false, reason: "missing signature" };
  }
  if (!signal.fromWallet) {
    return { ok: false, reason: "missing fromWallet" };
  }

  // Reject stale messages (replay defense).
  const ts = Date.parse(signal.timestamp);
  if (Number.isNaN(ts)) {
    return { ok: false, reason: "invalid timestamp" };
  }
  const age = Math.abs(Date.now() - ts);
  if (age > MAX_SIGNAL_AGE_MS) {
    return { ok: false, reason: `timestamp drift ${age}ms` };
  }

  const message = canonicalSignalPayload({ ...signal, signature: "" });
  let recovered: string;
  try {
    recovered = verifyMessage(message, signal.signature).toLowerCase();
  } catch (err) {
    return { ok: false, reason: `recover failed: ${(err as Error).message}` };
  }

  if (recovered !== signal.fromWallet.toLowerCase()) {
    return {
      ok: false,
      reason: `signer ${recovered} ≠ fromWallet ${signal.fromWallet.toLowerCase()}`,
      recovered,
    };
  }

  return { ok: true, recovered };
}
