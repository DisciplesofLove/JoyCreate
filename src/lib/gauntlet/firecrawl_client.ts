/**
 * Firecrawl client wrapper for the Left Gauntlet.
 *
 * Reads the API key from `process.env.FIRECRAWL_API_KEY` first, then falls
 * back to a settings-stored value. Throws `GauntletError("FIRECRAWL_KEY_MISSING")`
 * if neither is set. Hosted endpoint only (api.firecrawl.dev).
 */

import { Firecrawl } from "@mendable/firecrawl-js";
import { GauntletError } from "./types";
import { readSettings } from "@/main/settings";

let app: Firecrawl | null = null;
let cachedKey: string | null = null;

function resolveKey(): string {
  const envKey = process.env.FIRECRAWL_API_KEY?.trim();
  if (envKey) return envKey;
  try {
    const settings = readSettings();
    const settingsKey = (
      settings as unknown as { firecrawlApiKey?: string }
    ).firecrawlApiKey?.trim();
    if (settingsKey) return settingsKey;
  } catch {
    // ignore
  }
  throw new GauntletError(
    "FIRECRAWL_KEY_MISSING",
    "Firecrawl API key not set. Configure it in Gauntlet → Settings.",
  );
}

function getApp(): Firecrawl {
  const key = resolveKey();
  if (!app || cachedKey !== key) {
    app = new Firecrawl({ apiKey: key });
    cachedKey = key;
  }
  return app;
}

export interface FirecrawlScrapeOutput {
  markdown: string;
  rawHtml?: string;
  metadata?: Record<string, unknown>;
  sourceUrl: string;
}

export async function scrapeWithFirecrawl(
  targetUrl: string,
  cookieHeader?: string,
): Promise<FirecrawlScrapeOutput> {
  const fc = getApp();
  try {
    const result = await fc.scrape(targetUrl, {
      formats: ["markdown", "html"],
      onlyMainContent: true,
      ...(cookieHeader
        ? { headers: { Cookie: cookieHeader } as Record<string, string> }
        : {}),
    } as Parameters<Firecrawl["scrape"]>[1]);

    const markdown =
      typeof (result as { markdown?: unknown }).markdown === "string"
        ? ((result as { markdown: string }).markdown as string)
        : "";
    if (!markdown) {
      throw new GauntletError(
        "FIRECRAWL_FAILED",
        "Firecrawl returned no markdown content.",
      );
    }
    return {
      markdown,
      rawHtml: (result as { html?: string }).html,
      metadata: (result as { metadata?: Record<string, unknown> }).metadata,
      sourceUrl: targetUrl,
    };
  } catch (err) {
    if (err instanceof GauntletError) throw err;
    throw new GauntletError(
      "FIRECRAWL_FAILED",
      `Firecrawl scrape failed: ${(err as Error).message}`,
      err,
    );
  }
}

/** Lightweight ping for the Settings panel. */
export async function pingFirecrawl(): Promise<{ ok: true }> {
  // Issue a no-op scrape against a known-good URL.
  await scrapeWithFirecrawl("https://example.com");
  return { ok: true };
}
