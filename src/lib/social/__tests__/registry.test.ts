/**
 * Registry + adapter contract tests. The credential store is mocked so the
 * module loads without Electron's `safeStorage`.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("../credentials", () => ({
  hasAppCredentials: vi.fn(() => false),
  getAppCredentials: vi.fn(() => undefined),
  loadTokens: vi.fn(() => undefined),
  saveTokens: vi.fn(() => "secret-id"),
  updateTokens: vi.fn(),
}));

import {
  getProviderCapabilities,
  getSocialAdapter,
  listProviderInfo,
  listSupportedProviders,
} from "../registry";

describe("registry", () => {
  it("exposes all five providers", () => {
    expect(listSupportedProviders().sort()).toEqual([
      "facebook",
      "instagram",
      "linkedin",
      "reddit",
      "twitter",
    ]);
  });

  it("marks all five providers as fully implemented", () => {
    const info = listProviderInfo();
    for (const provider of [
      "reddit",
      "twitter",
      "linkedin",
      "facebook",
      "instagram",
    ] as const) {
      expect(info.find((p) => p.provider === provider)?.implemented).toBe(true);
    }
  });

  it("reports capabilities per provider", () => {
    expect(getProviderCapabilities("reddit").canReadEngagements).toBe(true);
    expect(getProviderCapabilities("twitter").maxTextLength).toBe(280);
  });

  it("adapters throw a clear not-configured error when credentials are missing", async () => {
    // credentials are mocked as absent in this suite
    await expect(getSocialAdapter("twitter").getAuthUrl!({
      redirectUri: "http://localhost/cb",
    })).rejects.toThrow(/not configured/i);
  });
});
