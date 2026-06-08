/**
 * Reddit reference adapter tests. `fetch` and the credential store are mocked
 * so the full request/response shaping is verified without network access.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const appCreds = { clientId: "cid", clientSecret: "secret", redirectUri: "http://localhost:53682/callback" };

vi.mock("../credentials", () => ({
  getAppCredentials: vi.fn(() => appCreds),
  hasAppCredentials: vi.fn(() => true),
  loadTokens: vi.fn(() => ({
    accessToken: "tok",
    refreshToken: "ref",
    expiresAt: Date.now() + 3_600_000,
  })),
  saveTokens: vi.fn(() => "secret-id"),
  updateTokens: vi.fn(),
}));

import { redditAdapter } from "../reddit";

const creds = { vaultSecretId: "secret-id", handle: "u/bot" };

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe("redditAdapter", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("builds an authorize URL with state and required scopes", async () => {
    const auth = await redditAdapter.getAuthUrl!({
      redirectUri: "http://localhost:53682/callback",
    });
    const url = new URL(auth.url);
    expect(url.searchParams.get("client_id")).toBe("cid");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("duration")).toBe("permanent");
    expect(url.searchParams.get("scope")).toContain("submit");
    expect(auth.state).toHaveLength(32);
  });

  it("submits a self post and returns the post id + permalink", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        json: { errors: [], data: { name: "t3_abc", url: "https://reddit.com/x" } },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await redditAdapter.post(creds, {
      text: "Hello",
      extras: { subreddit: "test" },
    });

    expect(result.externalPostId).toBe("t3_abc");
    expect(result.permalink).toBe("https://reddit.com/x");
    const [, init] = fetchMock.mock.calls[0];
    const body = (init as RequestInit).body as URLSearchParams;
    expect(body.get("kind")).toBe("self");
    expect(body.get("sr")).toBe("test");
  });

  it("throws when no subreddit is supplied", async () => {
    vi.stubGlobal("fetch", vi.fn());
    await expect(redditAdapter.post(creds, { text: "Hi" })).rejects.toThrow(
      /subreddit/i,
    );
  });

  it("normalizes inbox items into engagements", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        data: {
          children: [
            {
              kind: "t1",
              data: {
                name: "t1_1",
                author: "alice",
                body: "nice post",
                created_utc: 1_700_000_000,
                type: "comment_reply",
                parent_id: "t3_abc",
              },
            },
          ],
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const items = await redditAdapter.fetchEngagements!(creds, { limit: 10 });
    expect(items).toHaveLength(1);
    expect(items[0].externalId).toBe("t1_1");
    expect(items[0].type).toBe("comment");
    expect(items[0].authorHandle).toBe("u/alice");
    expect(items[0].receivedAt).toBe(1_700_000_000_000);
  });

  it("posts a reply and returns the comment id", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        json: { errors: [], data: { things: [{ data: { name: "t1_reply" } }] } },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await redditAdapter.reply!(
      creds,
      { externalId: "t1_1" },
      "thanks!",
    );
    expect(result.externalReplyId).toBe("t1_reply");
  });

  it("maps info response into metrics", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        data: { children: [{ data: { ups: 42, num_comments: 7 } }] },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const metrics = await redditAdapter.fetchMetrics!(creds, "t3_abc");
    expect(metrics.likes).toBe(42);
    expect(metrics.comments).toBe(7);
  });
});
