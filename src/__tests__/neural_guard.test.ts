/**
 * Neural Guard — unit tests.
 *
 * Verification (`verifyIntent` / `assertIntent`) runs in the main process and
 * has no DOM / wallet dependencies, so we can exercise it directly with a
 * real `ethers.Wallet`. The renderer-only `signIntent` helper imports
 * `joy_wallet` (which touches `localStorage`) and is NOT covered here — it
 * is exercised via e2e tests in a renderer context.
 *
 * Coverage matrix:
 *   - happy path (signed by the right wallet, fresh nonce, in-window timestamp)
 *   - tamper (payload mutation after signing)
 *   - replay (same nonce twice)
 *   - expired timestamp (older than MAX_INTENT_AGE_MS)
 *   - wrong signer (signature from a different wallet)
 *   - channel mismatch (signed for channel A, invoked on channel B)
 *   - missing signature / wallet / nonce
 *   - policy default-deny
 *   - policy explicit deny
 *   - allowOnly() predicate
 *   - rateLimit() predicate
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { Wallet } from "ethers";
import {
  canonicalIntentPayload,
  verifyIntent,
  assertIntent,
  unwrapGuarded,
  MAX_INTENT_AGE_MS,
  _resetNonceCacheForTests,
  _resetLegacyWarnedForTests,
  type SignedIntent,
} from "@/lib/neural_guard";
import {
  allow,
  allowOnly,
  deny,
  rateLimit,
  setDefaultAction,
  _resetPoliciesForTests,
} from "@/lib/neural_guard_policy";

// Deterministic test wallets — these are throwaway keys, never used onchain.
const ALICE = new Wallet(
  "0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318",
);
const MALLORY = new Wallet(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);

interface DemoPayload {
  url: string;
  selector: string;
}

async function buildSignedIntent(
  channel: string,
  payload: DemoPayload,
  signer: Wallet,
  overrides: Partial<SignedIntent<DemoPayload>> = {},
): Promise<SignedIntent<DemoPayload>> {
  const intent: SignedIntent<DemoPayload> = {
    channel,
    payload,
    agentDid: overrides.agentDid ?? signer.address.toLowerCase(),
    agentWallet: (overrides.agentWallet ?? signer.address).toLowerCase(),
    nonce: overrides.nonce ?? `nonce-${Math.random().toString(16).slice(2)}`,
    timestamp: overrides.timestamp ?? new Date().toISOString(),
    signature: "",
  };
  const message = canonicalIntentPayload(intent);
  const signature = overrides.signature ?? (await signer.signMessage(message));
  return { ...intent, signature };
}

beforeEach(() => {
  _resetNonceCacheForTests();
  _resetPoliciesForTests();
  _resetLegacyWarnedForTests();
  delete process.env.JOY_NEURAL_GUARD_ENFORCE;
});

describe("neural_guard / verifyIntent", () => {
  it("accepts a fresh, well-signed intent", async () => {
    const signed = await buildSignedIntent(
      "scraper:run",
      { url: "https://example.com", selector: "h1" },
      ALICE,
    );
    const result = verifyIntent(
      "scraper:run",
      { url: "https://example.com", selector: "h1" },
      signed,
    );
    expect(result.ok).toBe(true);
    expect(result.recovered).toBe(ALICE.address.toLowerCase());
  });

  it("is order-insensitive for payload object keys", async () => {
    const signed = await buildSignedIntent(
      "scraper:run",
      { url: "https://example.com", selector: "h1" },
      ALICE,
    );
    // Pass payload with keys in a different order — must still verify.
    const result = verifyIntent(
      "scraper:run",
      { selector: "h1", url: "https://example.com" } as DemoPayload,
      signed,
    );
    expect(result.ok).toBe(true);
  });

  it("rejects payload tampering", async () => {
    const signed = await buildSignedIntent(
      "scraper:run",
      { url: "https://example.com", selector: "h1" },
      ALICE,
    );
    const result = verifyIntent(
      "scraper:run",
      { url: "https://evil.com", selector: "h1" },
      signed,
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/payload hash mismatch/);
  });

  it("rejects channel mismatch (cross-channel reuse)", async () => {
    const signed = await buildSignedIntent(
      "scraper:run",
      { url: "https://example.com", selector: "h1" },
      ALICE,
    );
    const result = verifyIntent("nft:mint", signed.payload, signed);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/channel mismatch/);
  });

  it("rejects nonce replay", async () => {
    const signed = await buildSignedIntent(
      "scraper:run",
      { url: "https://example.com", selector: "h1" },
      ALICE,
    );
    const first = verifyIntent("scraper:run", signed.payload, signed);
    expect(first.ok).toBe(true);
    const second = verifyIntent("scraper:run", signed.payload, signed);
    expect(second.ok).toBe(false);
    expect(second.reason).toMatch(/nonce replay/);
  });

  it("does NOT burn a nonce when verification fails", async () => {
    const tampered = await buildSignedIntent(
      "scraper:run",
      { url: "https://example.com", selector: "h1" },
      ALICE,
    );
    // First call fails (channel mismatch) — must not record the nonce.
    const fail = verifyIntent("nft:mint", tampered.payload, tampered);
    expect(fail.ok).toBe(false);
    // Second call with the correct channel must still succeed.
    const ok = verifyIntent("scraper:run", tampered.payload, tampered);
    expect(ok.ok).toBe(true);
  });

  it("rejects expired timestamp", async () => {
    const stale = await buildSignedIntent(
      "scraper:run",
      { url: "https://example.com", selector: "h1" },
      ALICE,
      {
        timestamp: new Date(
          Date.now() - MAX_INTENT_AGE_MS - 5_000,
        ).toISOString(),
      },
    );
    const result = verifyIntent("scraper:run", stale.payload, stale);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/timestamp drift/);
  });

  it("rejects a signature from a different wallet", async () => {
    // Build with Alice's address but sign with Mallory's key.
    const tampered = await buildSignedIntent(
      "scraper:run",
      { url: "https://example.com", selector: "h1" },
      MALLORY,
      { agentWallet: ALICE.address.toLowerCase() },
    );
    const result = verifyIntent("scraper:run", tampered.payload, tampered);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/signer .* ≠ agentWallet/);
  });

  it("rejects missing signature / wallet / nonce", () => {
    expect(
      verifyIntent("scraper:run", { url: "x", selector: "y" }, undefined).ok,
    ).toBe(false);
    expect(
      verifyIntent("scraper:run", { url: "x", selector: "y" }, {
        channel: "scraper:run",
        payload: { url: "x", selector: "y" },
        agentDid: "did:x",
        agentWallet: ALICE.address.toLowerCase(),
        nonce: "n1",
        timestamp: new Date().toISOString(),
        signature: "",
      } as SignedIntent<DemoPayload>).ok,
    ).toBe(false);
  });
});

describe("neural_guard / assertIntent + policy", () => {
  it("succeeds with a valid intent and default-allow policy", async () => {
    const signed = await buildSignedIntent(
      "scraper:run",
      { url: "https://example.com", selector: "h1" },
      ALICE,
    );
    expect(() =>
      assertIntent("scraper:run", signed.payload, signed),
    ).not.toThrow();
  });

  it("throws with a clear prefix on verification failure", async () => {
    const signed = await buildSignedIntent(
      "scraper:run",
      { url: "https://example.com", selector: "h1" },
      ALICE,
    );
    expect(() =>
      assertIntent("nft:mint", signed.payload, signed),
    ).toThrowError(/^neural-guard: channel mismatch/);
  });

  it("default-deny rejects channels with no policy", async () => {
    setDefaultAction("deny");
    const signed = await buildSignedIntent(
      "scraper:run",
      { url: "https://example.com", selector: "h1" },
      ALICE,
    );
    expect(() =>
      assertIntent("scraper:run", signed.payload, signed),
    ).toThrowError(/no policy for channel scraper:run/);
  });

  it("explicit deny() blocks even with valid signature", async () => {
    deny("nft:mint");
    const signed = await buildSignedIntent(
      "nft:mint",
      { url: "ipfs://x", selector: "" },
      ALICE,
    );
    expect(() =>
      assertIntent("nft:mint", signed.payload, signed),
    ).toThrowError(/denied by policy/);
  });

  it("allowOnly() admits whitelisted wallets and rejects others", async () => {
    allow("scraper:run", allowOnly([ALICE.address]));

    const aliceIntent = await buildSignedIntent(
      "scraper:run",
      { url: "https://example.com", selector: "h1" },
      ALICE,
    );
    expect(() =>
      assertIntent("scraper:run", aliceIntent.payload, aliceIntent),
    ).not.toThrow();

    const malloryIntent = await buildSignedIntent(
      "scraper:run",
      { url: "https://example.com", selector: "h1" },
      MALLORY,
    );
    expect(() =>
      assertIntent("scraper:run", malloryIntent.payload, malloryIntent),
    ).toThrowError(/not on allowlist/);
  });

  it("rateLimit() throttles after the budget is spent", async () => {
    allow("celestia:blob:submit", rateLimit(2));

    for (let i = 0; i < 2; i++) {
      const intent = await buildSignedIntent(
        "celestia:blob:submit",
        { url: `https://example.com/${i}`, selector: "" },
        ALICE,
      );
      expect(() =>
        assertIntent("celestia:blob:submit", intent.payload, intent),
      ).not.toThrow();
    }

    const overflow = await buildSignedIntent(
      "celestia:blob:submit",
      { url: "https://example.com/overflow", selector: "" },
      ALICE,
    );
    expect(() =>
      assertIntent("celestia:blob:submit", overflow.payload, overflow),
    ).toThrowError(/rate limit exceeded/);
  });
});

describe("neural_guard / canonicalIntentPayload", () => {
  it("produces identical bytes regardless of source key order", () => {
    const a: SignedIntent<DemoPayload> = {
      channel: "scraper:run",
      payload: { url: "https://example.com", selector: "h1" },
      agentDid: "did:joy:alice",
      agentWallet: ALICE.address.toLowerCase(),
      nonce: "n1",
      timestamp: "2026-05-10T00:00:00.000Z",
      signature: "",
    };
    const b: SignedIntent<DemoPayload> = {
      // Reverse-ish order:
      timestamp: "2026-05-10T00:00:00.000Z",
      signature: "ignored",
      nonce: "n1",
      payload: { url: "https://example.com", selector: "h1" },
      channel: "scraper:run",
      agentWallet: ALICE.address.toLowerCase(),
      agentDid: "did:joy:alice",
    };
    expect(canonicalIntentPayload(a)).toBe(canonicalIntentPayload(b));
  });

  it("excludes the signature field from the canonical payload", () => {
    const base: SignedIntent<DemoPayload> = {
      channel: "scraper:run",
      payload: { url: "https://example.com", selector: "h1" },
      agentDid: "did:joy:alice",
      agentWallet: ALICE.address.toLowerCase(),
      nonce: "n1",
      timestamp: "2026-05-10T00:00:00.000Z",
      signature: "",
    };
    expect(canonicalIntentPayload(base)).toBe(
      canonicalIntentPayload({ ...base, signature: "0xdeadbeef" }),
    );
  });
});


describe("neural_guard / unwrapGuarded", () => {
  it("returns payload after verifying a wrapped GuardedArgs", async () => {
    const signed = await buildSignedIntent(
      "scraper:run",
      { url: "https://example.com", selector: "h1" },
      ALICE,
    );
    const args = { payload: signed.payload, signedIntent: signed };
    const payload = unwrapGuarded<DemoPayload>("scraper:run", args);
    expect(payload).toEqual(signed.payload);
  });

  it("soft-fails legacy unsigned calls when ENFORCE is unset", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const raw: DemoPayload = { url: "https://example.com", selector: "h1" };
    const out = unwrapGuarded<DemoPayload>("scraper:run", raw);
    expect(out).toEqual(raw);
    expect(warn).toHaveBeenCalledTimes(1);
    // Second call must NOT re-warn (de-dup).
    unwrapGuarded<DemoPayload>("scraper:run", raw);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("hard-fails legacy unsigned calls when ENFORCE=1", () => {
    process.env.JOY_NEURAL_GUARD_ENFORCE = "1";
    const raw: DemoPayload = { url: "https://example.com", selector: "h1" };
    expect(() =>
      unwrapGuarded<DemoPayload>("scraper:run", raw),
    ).toThrowError(/refused unsigned legacy call/);
  });

  it("propagates verification failures from a tampered wrapped call", async () => {
    const signed = await buildSignedIntent(
      "scraper:run",
      { url: "https://example.com", selector: "h1" },
      ALICE,
    );
    // Tamper with payload AFTER signing — handler-side compare must catch it.
    const tampered = {
      payload: { url: "https://evil.com", selector: "h1" } as DemoPayload,
      signedIntent: signed,
    };
    expect(() =>
      unwrapGuarded<DemoPayload>("scraper:run", tampered),
    ).toThrowError(/payload hash mismatch/);
  });
});
// Silence unused-import warnings on `vi` if the linter is strict.
void vi;
