/**
 * OAuth helper tests — PKCE generation, state randomness, and the pending-auth
 * store's remember/take semantics.
 */

import { describe, expect, it } from "vitest";

import {
  PendingAuthStore,
  generatePkce,
  randomState,
} from "../oauth_helpers";

describe("randomState", () => {
  it("produces unique 32-char hex tokens", () => {
    const a = randomState();
    const b = randomState();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
  });
});

describe("generatePkce", () => {
  it("produces a url-safe S256 verifier/challenge pair", () => {
    const { verifier, challenge, method } = generatePkce();
    expect(method).toBe("S256");
    expect(verifier).toMatch(/^[A-Za-z0-9\-_]+$/);
    expect(challenge).toMatch(/^[A-Za-z0-9\-_]+$/);
    expect(challenge).not.toBe(verifier);
  });
});

describe("PendingAuthStore", () => {
  it("returns stored data exactly once", () => {
    const store = new PendingAuthStore();
    store.remember("state-1", { redirectUri: "http://x/cb", codeVerifier: "v" });
    const first = store.take("state-1");
    expect(first?.redirectUri).toBe("http://x/cb");
    expect(first?.codeVerifier).toBe("v");
    // second take is empty (single-use)
    expect(store.take("state-1")).toBeUndefined();
  });

  it("returns undefined for an unknown state", () => {
    const store = new PendingAuthStore();
    expect(store.take("nope")).toBeUndefined();
  });
});
