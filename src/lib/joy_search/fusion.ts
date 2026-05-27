/**
 * Multi-engine result fusion for JoySearch.
 *
 * Combines per-engine ranked lists using Reciprocal Rank Fusion (RRF),
 * deduplicates by canonical URL (host + path, ignoring query/hash),
 * and multiplies the fused score by domain reputation before producing
 * the final ordering.
 */

import type { JoySearchEngine, JoySearchResult } from "../../types/joy_search";
import { reputationScore } from "./reputation";

/** Raw search hit from a single engine, with its position in that engine. */
export interface EngineHit {
  rank: number;
  title: string;
  url: string;
  snippet: string;
  engine: JoySearchEngine;
}

const RRF_K = 60;

function canonicalKey(url: string): string {
  try {
    const u = new URL(url);
    // Drop trailing slash and lowercase host. Keep path verbatim so
    // wiki/Foo and wiki/Bar stay distinct.
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    const path = u.pathname.replace(/\/+$/, "") || "/";
    return `${host}${path}`;
  } catch {
    return url;
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function faviconFor(url: string): string {
  const host = safeHost(url);
  if (!host) return "";
  // DuckDuckGo's favicon service — no API key, CORS friendly.
  return `https://icons.duckduckgo.com/ip3/${host}.ico`;
}

export function fuseAndRank(hitLists: EngineHit[][]): JoySearchResult[] {
  const merged = new Map<
    string,
    {
      title: string;
      url: string;
      snippet: string;
      sources: JoySearchEngine[];
      score: number;
      reputation: number;
    }
  >();

  for (const list of hitLists) {
    for (const hit of list) {
      const key = canonicalKey(hit.url);
      const rrf = 1 / (RRF_K + hit.rank);
      const existing = merged.get(key);
      if (existing) {
        existing.score += rrf;
        if (!existing.sources.includes(hit.engine)) {
          existing.sources.push(hit.engine);
        }
        // Prefer the longer snippet/title if the current one is empty.
        if (!existing.snippet && hit.snippet) existing.snippet = hit.snippet;
        if (existing.title.length < hit.title.length) existing.title = hit.title;
      } else {
        merged.set(key, {
          title: hit.title,
          url: hit.url,
          snippet: hit.snippet,
          sources: [hit.engine],
          score: rrf,
          reputation: reputationScore(safeHost(hit.url)),
        });
      }
    }
  }

  const sorted = [...merged.values()].sort(
    (a, b) => b.score * b.reputation - a.score * a.reputation,
  );

  return sorted.map<JoySearchResult>((m, i) => ({
    rank: i + 1,
    title: m.title.trim() || m.url,
    url: m.url,
    displayUrl: safeHost(m.url),
    snippet: m.snippet.trim(),
    faviconUrl: faviconFor(m.url),
    sources: m.sources,
    reputation: m.reputation,
  }));
}
