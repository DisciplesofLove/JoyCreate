/**
 * Server-side article extraction for JoySearch.
 *
 * Fetches a URL with a realistic UA, runs a cheerio-based readability
 * heuristic (largest text container with low link density), strips
 * boilerplate, and returns clean text + metadata.
 *
 * We deliberately avoid JSDOM + @mozilla/readability here to keep the
 * dependency surface small and the extraction fast. The heuristic
 * mirrors the in-page extractor in SmartBrowserPage.getPageSnapshot.
 */

import * as cheerio from "cheerio";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36";

const MAX_TEXT = 32_000;

export interface ExtractedArticle {
  url: string;
  finalUrl: string;
  title: string;
  text: string;
  byline?: string;
  excerpt?: string;
  lang?: string;
}

function cleanText(s: string): string {
  return s
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function getMeta($: cheerio.CheerioAPI, name: string): string {
  const el = $(`meta[name="${name}"], meta[property="${name}"]`).first();
  return (el.attr("content") || "").trim();
}

/** Score a node by text length × (1 − link density). */
function scoreNode($: cheerio.CheerioAPI, el: cheerio.Cheerio<any>): number {
  const text = el.text() || "";
  const linkText = el.find("a").text() || "";
  const linkDensity =
    text.length === 0 ? 1 : Math.min(1, linkText.length / text.length);
  return text.length * (1 - linkDensity);
}

export async function fetchAndExtract(
  url: string,
  signal?: AbortSignal,
): Promise<ExtractedArticle> {
  const resp = await fetch(url, {
    headers: {
      "User-Agent": UA,
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "en-US,en;q=0.9",
    },
    redirect: "follow",
    signal,
  });
  if (!resp.ok) {
    throw new Error(`Fetch ${url} returned HTTP ${resp.status}`);
  }
  const contentType = resp.headers.get("content-type") || "";
  if (!/text\/html|application\/xhtml/i.test(contentType)) {
    throw new Error(`Not an HTML page (content-type: ${contentType || "unknown"})`);
  }
  const html = await resp.text();
  const $ = cheerio.load(html);

  // Drop boilerplate everywhere.
  $("script, style, noscript, svg, iframe, nav, aside, header, footer, form, button").remove();

  // Candidate containers, in order of preference.
  const candidates = [
    "article",
    "main",
    "[role=main]",
    "#main",
    "#content",
    ".content",
    ".post",
    ".article",
    ".entry-content",
    "body",
  ];

  let best: cheerio.Cheerio<any> | null = null;
  let bestScore = 0;
  for (const sel of candidates) {
    $(sel).each((_, el) => {
      const node = $(el);
      const s = scoreNode($, node);
      if (s > bestScore) {
        bestScore = s;
        best = node;
      }
    });
  }
  if (!best) best = $("body");

  let text = cleanText(best!.text());
  if (text.length > MAX_TEXT) {
    text = `${text.slice(0, MAX_TEXT)}\n\n[…truncated]`;
  }

  const title =
    ($("title").first().text() || getMeta($, "og:title") || "").trim();
  const description = getMeta($, "description") || getMeta($, "og:description");
  const lang = $("html").attr("lang") || undefined;
  const byline =
    getMeta($, "author") ||
    $('meta[name="article:author"]').attr("content") ||
    undefined;

  return {
    url,
    finalUrl: resp.url || url,
    title,
    text,
    byline: byline?.trim() || undefined,
    excerpt: description || undefined,
    lang: lang?.trim() || undefined,
  };
}
