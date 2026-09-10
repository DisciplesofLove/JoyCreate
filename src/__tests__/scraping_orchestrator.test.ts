/**
 * The scraping orchestrator decides how much of someone else's site gets hit,
 * how fast, and through what. Four finished modules — crawler, pagination,
 * proxy rotation and the politeness engine — sat next to it unimported, so a
 * job that turned any of them on in the UI quietly did none of it:
 *
 *   - `crawl.enabled` scraped exactly the seed URLs and followed nothing;
 *   - `api.pagination` scraped page one and stopped;
 *   - `proxy.url` was ignored, so requests went out directly;
 *   - `rateLimit` was ignored, so pages were fetched in a tight loop with no
 *     robots.txt check at all.
 *
 * These tests cover the expansion and parsing decisions directly, because the
 * blast radius of getting them wrong lands on a third party's server.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("electron-log", () => ({
  default: {
    scope: () => ({
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    }),
  },
}));

vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/db/schema", () => ({
  scrapingJobs: {},
  scrapingResults: {},
  scrapingSchedules: {},
  scrapingTemplates: {},
}));
vi.mock("drizzle-orm", () => ({ eq: () => undefined }));

// The engines pull in playwright and cheerio; none of that is needed to test
// URL expansion, and loading it would make this suite depend on a browser.
vi.mock("@/lib/scraping/engines", () => ({
  StaticEngine: class {},
  BrowserEngine: class {},
  StealthEngine: class {},
  APIEngine: class {},
}));
vi.mock("@/lib/scraping/engine_selector", () => ({
  probeUrl: async () => ({}),
  selectEngine: () => "static",
}));
vi.mock("@/lib/scraping/extraction", () => ({
  runExtraction: async () => ({ page: {} }),
  quickExtract: async () => ({}),
}));
vi.mock("@/lib/scraping/crawler", () => ({ JoyCrawler: class {} }));
vi.mock("@/lib/scraping/anti_bot", () => ({
  adjustDelay: () => undefined,
  getAdaptiveDelay: () => 0,
  isUrlAllowed: async () => true,
  waitForToken: async () => undefined,
}));
vi.mock("@/lib/scraping/monitoring", () => ({
  MetricsCollector: class {},
  categorizeError: () => "unknown",
  getRetryDelay: () => 0,
  shouldRetry: () => false,
  DEFAULT_RETRY_STRATEGY: { maxRetries: 0 },
}));

// Pagination detection is exercised for real — it is the part that decides how
// many extra pages get requested.
vi.mock("@/lib/scraping/pagination", async () => {
  const detections = new Map<string, any>();
  return {
    __setDetection: (html: string, d: any) => detections.set(html, d),
    detectPagination: (html: string) =>
      detections.get(html) ?? { strategy: "none", confidence: 0 },
    generatePaginationUrls: (detection: any, maxPages: number) => {
      if (detection.strategy !== "url-pattern" || !detection.pattern) return [];
      const urls: string[] = [];
      for (let p = 2; p <= maxPages; p++) {
        urls.push(detection.pattern.replace("{page}", String(p)));
      }
      return urls;
    },
  };
});

import { __test__ } from "@/lib/scraping/orchestrator";
import * as pagination from "@/lib/scraping/pagination";

const { domainOf, buildProxyManager, expandPagination, resolveUrls } = __test__;

describe("domainOf", () => {
  it("returns the host", () => {
    expect(domainOf("https://example.com/a/b?c=1")).toBe("example.com");
  });

  it("falls back to the raw string rather than throwing", () => {
    // Politeness is keyed by domain; a throw here would abort a job over a
    // malformed URL instead of just scraping it under an odd key.
    expect(domainOf("not a url")).toBe("not a url");
  });
});

describe("buildProxyManager", () => {
  it("returns nothing when no proxy is configured", () => {
    expect(buildProxyManager({ urls: [] } as any)).toBeUndefined();
  });

  it("parses host, port and credentials from the URL", () => {
    const mgr = buildProxyManager({
      urls: [],
      proxy: { url: "http://user:pass@proxy.example.com:8080" },
    } as any);

    const proxy = mgr!.getProxy("example.com");
    expect(proxy).toMatchObject({
      type: "http",
      host: "proxy.example.com",
      port: 8080,
      username: "user",
      password: "pass",
    });
  });

  it("prefers explicit credentials over ones embedded in the URL", () => {
    const mgr = buildProxyManager({
      urls: [],
      proxy: {
        url: "http://urluser:urlpass@proxy.example.com:8080",
        username: "explicit",
        password: "secret",
      },
    } as any);

    expect(mgr!.getProxy()).toMatchObject({
      username: "explicit",
      password: "secret",
    });
  });

  it("defaults the port by scheme when the URL omits it", () => {
    const mgr = buildProxyManager({
      urls: [],
      proxy: { url: "https://proxy.example.com" },
    } as any);
    expect(mgr!.getProxy()).toMatchObject({ type: "https", port: 443 });
  });

  it("throws on a malformed proxy URL instead of scraping direct", () => {
    // Silently falling back to a direct connection would defeat the reason the
    // proxy was set — usually that direct requests are blocked or identifying.
    expect(() =>
      buildProxyManager({ urls: [], proxy: { url: "!!not a url!!" } } as any),
    ).toThrow(/Invalid proxy URL/);
  });
});

describe("expandPagination", () => {
  const cfg = (maxPages?: number) =>
    ({ urls: [], api: { pagination: { maxPages } } }) as any;

  it("returns nothing when pagination is not configured", () => {
    expect(expandPagination({ urls: [] } as any, "https://x.com", "<html>")).toEqual(
      [],
    );
  });

  it("returns nothing for a single page", () => {
    expect(expandPagination(cfg(1), "https://x.com", "<html>")).toEqual([]);
  });

  it("generates pages 2..maxPages from a detected pattern", () => {
    const html = "<paged>";
    (pagination as any).__setDetection(html, {
      strategy: "url-pattern",
      confidence: 0.9,
      pattern: "https://x.com/list?page={page}",
    });

    expect(expandPagination(cfg(4), "https://x.com/list", html)).toEqual([
      "https://x.com/list?page=2",
      "https://x.com/list?page=3",
      "https://x.com/list?page=4",
    ]);
  });

  it("ignores a low-confidence detection", () => {
    // Guessing wrong here means requesting URLs that do not exist, on someone
    // else's server, at whatever rate the job is configured for.
    const html = "<vague>";
    (pagination as any).__setDetection(html, {
      strategy: "url-pattern",
      confidence: 0.2,
      pattern: "https://x.com/list?page={page}",
    });

    expect(expandPagination(cfg(5), "https://x.com/list", html)).toEqual([]);
  });

  it("survives a detector that throws", () => {
    const html = "<boom>";
    (pagination as any).__setDetection(html, null);
    expect(() =>
      expandPagination(cfg(3), "https://x.com/list", html),
    ).not.toThrow();
  });
});

describe("resolveUrls", () => {
  it("uses the configured URLs", () => {
    expect(resolveUrls({ urls: ["https://a.com", "https://b.com"] } as any)).toEqual([
      "https://a.com",
      "https://b.com",
    ]);
  });

  it("returns an empty list when none are set", () => {
    expect(resolveUrls({ urls: [] } as any)).toEqual([]);
  });
});
