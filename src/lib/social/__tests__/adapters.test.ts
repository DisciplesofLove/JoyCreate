/**
 * Adapter tests for the newly-wired platforms (Twitter/X, LinkedIn, Facebook,
 * Instagram). `fetch` and the credential store are mocked so request shaping
 * and response handling are verified without network access.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const app = {
  clientId: "cid",
  clientSecret: "secret",
  redirectUri: "http://localhost:53682/callback",
};

vi.mock("../credentials", () => ({
  getAppCredentials: vi.fn(() => app),
  hasAppCredentials: vi.fn(() => true),
  loadTokens: vi.fn(() => ({ accessToken: "tok", refreshToken: "ref" })),
  saveTokens: vi.fn(() => "secret-id"),
  updateTokens: vi.fn(),
}));

import { facebookAdapter } from "../facebook";
import { instagramAdapter } from "../instagram";
import { linkedinAdapter } from "../linkedin";
import { twitterAdapter } from "../twitter";

const REDIRECT = "http://localhost:53682/callback";

function jsonResponse(
  body: unknown,
  ok = true,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return {
    ok,
    status,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("twitterAdapter", () => {
  it("builds a PKCE authorize URL with state", async () => {
    const auth = await twitterAdapter.getAuthUrl!({ redirectUri: REDIRECT });
    const url = new URL(auth.url);
    expect(url.searchParams.get("client_id")).toBe("cid");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBeTruthy();
    expect(url.searchParams.get("state")).toBe(auth.state);
  });

  it("posts a tweet and returns id + permalink", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ data: { id: "123" } })),
    );
    const result = await twitterAdapter.post(
      { vaultSecretId: "secret-id", extra: { username: "bot" } },
      { text: "hello" },
    );
    expect(result.externalPostId).toBe("123");
    expect(result.permalink).toBe("https://x.com/bot/status/123");
  });

  it("connect requires authCode and state", async () => {
    await expect(twitterAdapter.connect({})).rejects.toThrow(/authCode/i);
  });

  it("completes the PKCE round-trip on connect", async () => {
    const auth = await twitterAdapter.getAuthUrl!({ redirectUri: REDIRECT });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        // token exchange
        .mockResolvedValueOnce(
          jsonResponse({ access_token: "at", refresh_token: "rt", expires_in: 7200 }),
        )
        // /users/me
        .mockResolvedValueOnce(
          jsonResponse({ data: { id: "u1", username: "bot", name: "Bot" } }),
        ),
    );
    const res = await twitterAdapter.connect({
      authCode: "code",
      state: auth.state,
      redirectUri: REDIRECT,
    });
    expect(res.externalId).toBe("u1");
    expect(res.label).toBe("@bot");
    expect(res.credentials.extra?.userId).toBe("u1");
  });
});

describe("linkedinAdapter", () => {
  it("posts a share and reads the share id from the response header", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({}, true, 201, { "x-restli-id": "urn:li:share:99" }),
      ),
    );
    const result = await linkedinAdapter.post(
      { vaultSecretId: "secret-id", extra: { memberId: "m1" } },
      { text: "hi linkedin" },
    );
    expect(result.externalPostId).toBe("urn:li:share:99");
    expect(result.permalink).toContain("urn:li:share:99");
  });

  it("requires a member id to post", async () => {
    vi.stubGlobal("fetch", vi.fn());
    await expect(
      linkedinAdapter.post({ vaultSecretId: "secret-id" }, { text: "x" }),
    ).rejects.toThrow(/member id/i);
  });
});

describe("facebookAdapter", () => {
  it("posts to the page feed", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ id: "100_200" }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await facebookAdapter.post(
      { vaultSecretId: "secret-id", extra: { pageId: "100" } },
      { text: "page post" },
    );
    expect(result.externalPostId).toBe("100_200");
    const [calledUrl] = fetchMock.mock.calls[0];
    expect(String(calledUrl)).toContain("/100/feed");
  });

  it("maps comments into engagements", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          data: [
            {
              id: "c1",
              message: "nice",
              from: { id: "u9", name: "Ada" },
              created_time: "2024-01-01T00:00:00+0000",
            },
          ],
        }),
      ),
    );
    const items = await facebookAdapter.fetchEngagements!(
      { vaultSecretId: "secret-id", extra: { pageId: "100" } },
      { limit: 10, externalPostIds: ["100_200"] },
    );
    expect(items).toHaveLength(1);
    expect(items[0].externalId).toBe("c1");
    expect(items[0].authorDisplayName).toBe("Ada");
  });
});

describe("instagramAdapter", () => {
  it("rejects publishing without a public image URL", async () => {
    vi.stubGlobal("fetch", vi.fn());
    await expect(
      instagramAdapter.post(
        { vaultSecretId: "secret-id", extra: { igUserId: "ig1" } },
        { text: "caption" },
      ),
    ).rejects.toThrow(/public image url/i);
  });

  it("publishes via the two-step container flow", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ id: "creation1" })) // create
        .mockResolvedValueOnce(jsonResponse({ id: "media1" })), // publish
    );
    const result = await instagramAdapter.post(
      { vaultSecretId: "secret-id", extra: { igUserId: "ig1", username: "bot" } },
      { text: "caption", extras: { imageUrl: "https://example.com/a.jpg" } },
    );
    expect(result.externalPostId).toBe("media1");
  });
});
