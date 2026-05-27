/**
 * Brave Search HTML scrape — keyless.
 *
 * Brave's web result page is more JS-heavy than DuckDuckGo's but the SSR
 * fallback still contains organic results inside `<div class="snippet">`
 * blocks. We tolerate selector drift by checking multiple candidates.
 */

import * as cheerio from "cheerio";
import type { EngineHit } from "../fusion";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36";

export async function braveSearch(
  q: string,
  opts: { page?: number; safe?: "off" | "moderate" | "strict" } = {},
): Promise<EngineHit[]> {
  const params = new URLSearchParams({ q, source: "web" });
  if (opts.page && opts.page > 1) params.set("offset", String(opts.page - 1));
  if (opts.safe === "strict") params.set("safesearch", "strict");
  else if (opts.safe === "moderate") params.set("safesearch", "moderate");
  else params.set("safesearch", "off");

  const resp = await fetch(`https://search.brave.com/search?${params}`, {
    headers: {
      "User-Agent": UA,
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "en-US,en;q=0.9",
    },
  });
  if (!resp.ok) {
    throw new Error(`Brave HTTP ${resp.status}`);
  }
  const html = await resp.text();
  const $ = cheerio.load(html);
  const out: EngineHit[] = [];

  // Brave wraps each organic result in a div with class containing
  // "snippet" and data-type="web". Title is in <a class="h"> or first <a>.
  $("div.snippet, div[data-type=web]").each((i, el) => {
    const $el = $(el);
    const a = $el.find("a[href^=http]").first();
    const href = a.attr("href") || "";
    if (!/^https?:/i.test(href)) return;
    const title =
      $el.find(".title").first().text().trim() ||
      a.text().trim().split("\n")[0] ||
      "";
    const snippet =
      $el.find(".snippet-description").first().text().trim() ||
      $el.find(".snippet-content").first().text().trim() ||
      "";
    if (!title) return;
    out.push({
      rank: out.length + 1,
      title,
      url: href,
      snippet,
      engine: "brave",
    });
  });

  return out;
}
