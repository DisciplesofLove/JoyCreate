/**
 * DuckDuckGo HTML scrape — keyless, no rate limits beyond IP throttling.
 *
 * Uses the lite HTML endpoint at https://html.duckduckgo.com/html/?q=...
 * which serves a static SSR result list (no JS required, easy to parse).
 *
 * Also exposes a `suggest()` for the JSON autocomplete endpoint at
 * https://duckduckgo.com/ac/?q=...&type=list which returns a simple
 * array of strings.
 */

import * as cheerio from "cheerio";
import type { EngineHit } from "../fusion";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36";

/** DuckDuckGo wraps result URLs in /l/?uddg=ENCODED — unwrap them. */
function unwrap(href: string): string {
  if (!href) return "";
  if (href.startsWith("//")) href = `https:${href}`;
  try {
    const u = new URL(href, "https://duckduckgo.com");
    if (u.pathname === "/l/" || u.pathname === "/l") {
      const real = u.searchParams.get("uddg");
      if (real) return decodeURIComponent(real);
    }
    return u.toString();
  } catch {
    return href;
  }
}

export async function duckDuckGoSearch(
  q: string,
  opts: { page?: number; region?: string; safe?: "off" | "moderate" | "strict" } = {},
): Promise<EngineHit[]> {
  const params = new URLSearchParams({ q });
  if (opts.region) params.set("kl", opts.region);
  if (opts.safe === "strict") params.set("kp", "1");
  else if (opts.safe === "moderate") params.set("kp", "-1");
  else params.set("kp", "-2");
  if (opts.page && opts.page > 1) {
    params.set("s", String((opts.page - 1) * 30));
    params.set("dc", String((opts.page - 1) * 30 + 1));
  }

  const resp = await fetch(`https://html.duckduckgo.com/html/?${params}`, {
    method: "POST",
    headers: {
      "User-Agent": UA,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "text/html,application/xhtml+xml",
    },
    body: params.toString(),
  });
  if (!resp.ok) {
    throw new Error(`DuckDuckGo HTTP ${resp.status}`);
  }
  const html = await resp.text();
  const $ = cheerio.load(html);
  const out: EngineHit[] = [];

  $(".result").each((i, el) => {
    const $el = $(el);
    if ($el.hasClass("result--ad") || $el.hasClass("result--more")) return;
    const aTitle = $el.find("a.result__a").first();
    const title = aTitle.text().trim();
    const href = unwrap(aTitle.attr("href") || "");
    const snippet = $el.find(".result__snippet").first().text().trim();
    if (!title || !href || !/^https?:/i.test(href)) return;
    out.push({
      rank: out.length + 1,
      title,
      url: href,
      snippet,
      engine: "duckduckgo",
    });
  });

  return out;
}

export async function duckDuckGoSuggest(q: string): Promise<string[]> {
  if (!q.trim()) return [];
  const resp = await fetch(
    `https://duckduckgo.com/ac/?q=${encodeURIComponent(q)}&type=list`,
    { headers: { "User-Agent": UA, Accept: "application/json" } },
  );
  if (!resp.ok) return [];
  const data = (await resp.json()) as unknown;
  // Response is [query, [...suggestions]]
  if (Array.isArray(data) && Array.isArray(data[1])) {
    return (data[1] as unknown[]).filter((s): s is string => typeof s === "string");
  }
  return [];
}
