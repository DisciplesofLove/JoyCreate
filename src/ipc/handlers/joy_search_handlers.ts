/**
 * JoySearch IPC Handlers — local-AI-powered web search.
 *
 * Channels:
 *   joy-search:query       → JoySearchQueryResponse  (multi-engine + fusion + reputation)
 *   joy-search:fetch-page  → JoySearchFetchPageResponse  (server-side article extraction)
 *   joy-search:lens        → JoySearchLensResponse   (summarize/key-points/fact-check/translate/...)
 *   joy-search:answer      → JoySearchAnswerResponse (Perplexity-style grounded answer with citations)
 *   joy-search:suggest     → JoySearchSuggestResponse (autocomplete)
 *
 * All handlers throw on error per repo convention.
 */

import log from "electron-log";
import { createLoggedHandler } from "./safe_handle";
import { getOllamaApiUrl } from "./local_model_ollama_handler";
import { readSettings } from "../../main/settings";
import { TtlCache } from "../../lib/joy_search/cache";
import { fuseAndRank, type EngineHit } from "../../lib/joy_search/fusion";
import { duckDuckGoSearch, duckDuckGoSuggest } from "../../lib/joy_search/engines/duckduckgo";
import { braveSearch } from "../../lib/joy_search/engines/brave";
import { fetchAndExtract } from "../../lib/joy_search/readability_extract";
import {
  ANSWER_SYSTEM_PROMPT,
  LENS_SPECS,
  stripJsonFences,
} from "../../lib/joy_search/lens_prompts";
import type {
  JoySearchAnswerRequest,
  JoySearchAnswerResponse,
  JoySearchCitation,
  JoySearchEngine,
  JoySearchFactClaim,
  JoySearchFetchPageRequest,
  JoySearchFetchPageResponse,
  JoySearchIntent,
  JoySearchKeyPoint,
  JoySearchLensRequest,
  JoySearchLensResponse,
  JoySearchPullQuote,
  JoySearchQueryRequest,
  JoySearchQueryResponse,
  JoySearchResult,
  JoySearchSuggestRequest,
  JoySearchSuggestResponse,
} from "../../types/joy_search";

const logger = log.scope("joy_search_handlers");
const handle = createLoggedHandler(logger);

// ── Caches ────────────────────────────────────────────────────────────────

const QUERY_TTL = 10 * 60 * 1000;
const PAGE_TTL = 30 * 60 * 1000;
const SUGGEST_TTL = 5 * 60 * 1000;
const ANSWER_TTL = 10 * 60 * 1000;

const queryCache = new TtlCache<string, JoySearchQueryResponse>(200);
const pageCache = new TtlCache<string, JoySearchFetchPageResponse>(300);
const suggestCache = new TtlCache<string, string[]>(200);
const answerCache = new TtlCache<string, JoySearchAnswerResponse>(100);

// ── Settings helpers ──────────────────────────────────────────────────────

function getDefaultModel(): string {
  return readSettings().selectedModel?.name || "qwen2.5-coder:7b";
}

// ── Intent detection (heuristic) ──────────────────────────────────────────

function classifyIntent(q: string): JoySearchIntent {
  const s = q.trim().toLowerCase();
  if (/^https?:\/\//i.test(s) || /\.[a-z]{2,}$/i.test(s.split(/\s/)[0])) {
    return "navigational";
  }
  if (/\b(how to|how do|how can|steps to|guide to)\b/.test(s)) return "how-to";
  if (/\b(buy|price|cheap|deal|review|vs\.?)\b/.test(s)) return "shopping";
  if (/\b(news|latest|today|breaking|update)\b/.test(s)) return "news";
  if (
    /\b(error|exception|function|class|api|library|sdk|npm|pip)\b/.test(s) ||
    /[{}();<>]/.test(s)
  ) {
    return "code";
  }
  if (/^(what|who|when|where|why|which|how many|how much)\b/.test(s)) {
    return "factual";
  }
  return "general";
}

// ── joy-search:query ──────────────────────────────────────────────────────

async function runEngine(
  engine: JoySearchEngine,
  q: string,
  req: JoySearchQueryRequest,
): Promise<EngineHit[]> {
  try {
    if (engine === "duckduckgo") {
      return await duckDuckGoSearch(q, {
        page: req.page,
        region: req.region,
        safe: req.safe,
      });
    }
    if (engine === "brave") {
      return await braveSearch(q, { page: req.page, safe: req.safe });
    }
    return [];
  } catch (err) {
    logger.warn(`Engine ${engine} failed:`, (err as Error).message);
    return [];
  }
}

async function aiRerank(
  q: string,
  results: JoySearchResult[],
): Promise<JoySearchResult[]> {
  if (results.length === 0) return results;
  const model = getDefaultModel();
  const top = results.slice(0, 20);
  const payload = top.map((r) => ({
    rank: r.rank,
    title: r.title,
    snippet: r.snippet.slice(0, 200),
    url: r.displayUrl,
  }));
  const sys = `You rerank web search results by relevance to a user query. Respond with ONLY a JSON object:
{ "ranking": [ { "rank": number, "score": number } ] }
where "rank" is from the input and "score" is 0..1.`;
  const usr = `Query: ${q}\n\nResults:\n${JSON.stringify(payload, null, 2)}`;
  try {
    const resp = await fetch(`${getOllamaApiUrl()}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        stream: false,
        format: "json",
        options: { temperature: 0.1 },
        messages: [
          { role: "system", content: sys },
          { role: "user", content: usr },
        ],
      }),
    });
    if (!resp.ok) return results;
    const data = (await resp.json()) as { message?: { content?: string } };
    const content = data.message?.content?.trim() || "";
    const parsed = JSON.parse(stripJsonFences(content)) as {
      ranking?: Array<{ rank: number; score: number }>;
    };
    if (!Array.isArray(parsed.ranking)) return results;
    const scoreMap = new Map<number, number>();
    for (const r of parsed.ranking) {
      if (typeof r.rank === "number" && typeof r.score === "number") {
        scoreMap.set(r.rank, r.score);
      }
    }
    const reranked = [...top].sort(
      (a, b) => (scoreMap.get(b.rank) ?? 0) - (scoreMap.get(a.rank) ?? 0),
    );
    return [
      ...reranked.map((r, i) => ({ ...r, rank: i + 1 })),
      ...results.slice(20),
    ];
  } catch (err) {
    logger.warn("AI rerank failed:", (err as Error).message);
    return results;
  }
}

// ── joy-search:fetch-page ─────────────────────────────────────────────────

async function fetchPageCached(url: string): Promise<JoySearchFetchPageResponse> {
  const hit = pageCache.get(url);
  if (hit) return { ...hit, cached: true };
  const extracted = await fetchAndExtract(url);
  const resp: JoySearchFetchPageResponse = {
    url: extracted.url,
    finalUrl: extracted.finalUrl,
    title: extracted.title,
    text: extracted.text,
    byline: extracted.byline,
    excerpt: extracted.excerpt,
    lang: extracted.lang,
    fetchedAt: Date.now(),
    cached: false,
  };
  pageCache.set(url, resp, PAGE_TTL);
  return resp;
}

// ── Registration ──────────────────────────────────────────────────────────

export function registerJoySearchHandlers(): void {
  // ── joy-search:query ────────────────────────────────────────────────────
  handle(
    "joy-search:query",
    async (_e, req: JoySearchQueryRequest): Promise<JoySearchQueryResponse> => {
      const q = (req?.q || "").trim();
      if (!q) throw new Error("query is empty");

      const enginesRequested: JoySearchEngine[] =
        req.engines && req.engines.length > 0 ? req.engines : ["duckduckgo", "brave"];
      const cacheKey = JSON.stringify({
        q,
        p: req.page ?? 1,
        r: req.region ?? "",
        s: req.safe ?? "moderate",
        e: enginesRequested.slice().sort(),
        ai: !!req.aiRerank,
      });
      const cached = queryCache.get(cacheKey);
      if (cached) return { ...cached, cached: true };

      const started = Date.now();
      const hitLists = await Promise.all(
        enginesRequested.map((e) => runEngine(e, q, req)),
      );
      let results = fuseAndRank(hitLists);
      if (req.aiRerank) {
        results = await aiRerank(q, results);
      }

      // Best-effort suggestions in parallel (don't block on failure).
      const suggestions = await duckDuckGoSuggest(q).catch(() => [] as string[]);

      const resp: JoySearchQueryResponse = {
        q,
        results,
        suggestions: suggestions.filter((s) => s.toLowerCase() !== q.toLowerCase()).slice(0, 8),
        intent: classifyIntent(q),
        enginesUsed: enginesRequested,
        tookMs: Date.now() - started,
        cached: false,
      };
      queryCache.set(cacheKey, resp, QUERY_TTL);
      return resp;
    },
  );

  // ── joy-search:fetch-page ──────────────────────────────────────────────
  handle(
    "joy-search:fetch-page",
    async (
      _e,
      req: JoySearchFetchPageRequest,
    ): Promise<JoySearchFetchPageResponse> => {
      const url = (req?.url || "").trim();
      if (!url || !/^https?:\/\//i.test(url)) {
        throw new Error("url must be an absolute http(s) URL");
      }
      return await fetchPageCached(url);
    },
  );

  // ── joy-search:lens ────────────────────────────────────────────────────
  handle(
    "joy-search:lens",
    async (_e, req: JoySearchLensRequest): Promise<JoySearchLensResponse> => {
      const url = (req?.url || "").trim();
      if (!url) throw new Error("url is required");
      const spec = LENS_SPECS[req.mode];
      if (!spec) throw new Error(`Unknown lens mode "${req.mode}"`);

      const page = await fetchPageCached(url);
      if (!page.text || page.text.length < 30) {
        throw new Error("Page had no extractable text for this lens.");
      }

      const model = req.model || getDefaultModel();
      const started = Date.now();
      const userMsg = spec.buildUser({
        title: page.title,
        url: page.finalUrl,
        text: page.text,
        targetLang: req.targetLang,
      });

      const ollamaResp = await fetch(`${getOllamaApiUrl()}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          stream: false,
          format: spec.structured ? "json" : undefined,
          options: { temperature: spec.structured ? 0.1 : 0.3 },
          messages: [
            { role: "system", content: spec.system },
            { role: "user", content: userMsg },
          ],
        }),
      });
      if (!ollamaResp.ok) {
        throw new Error(`Ollama ${ollamaResp.status} ${ollamaResp.statusText}`);
      }
      const data = (await ollamaResp.json()) as { message?: { content?: string } };
      const content = data.message?.content?.trim() || "";
      if (!content) throw new Error("Lens returned empty response");

      const base: JoySearchLensResponse = {
        url: page.finalUrl,
        mode: req.mode,
        model,
        tookMs: Date.now() - started,
      };

      if (!spec.structured) {
        return { ...base, text: content };
      }

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(stripJsonFences(content)) as Record<string, unknown>;
      } catch (err) {
        throw new Error(
          `Lens "${req.mode}" returned invalid JSON: ${(err as Error).message}`,
        );
      }

      switch (req.mode) {
        case "key-points": {
          const arr = (parsed.keyPoints as JoySearchKeyPoint[]) || [];
          return { ...base, keyPoints: arr.filter((p) => typeof p?.point === "string") };
        }
        case "fact-check": {
          const arr = (parsed.claims as JoySearchFactClaim[]) || [];
          return { ...base, claims: arr.filter((c) => typeof c?.claim === "string") };
        }
        case "pull-quotes": {
          const arr = (parsed.quotes as JoySearchPullQuote[]) || [];
          return { ...base, quotes: arr.filter((q) => typeof q?.quote === "string") };
        }
        default:
          return base;
      }
    },
  );

  // ── joy-search:answer ──────────────────────────────────────────────────
  handle(
    "joy-search:answer",
    async (_e, req: JoySearchAnswerRequest): Promise<JoySearchAnswerResponse> => {
      const q = (req?.q || "").trim();
      if (!q) throw new Error("query is empty");
      const max = Math.min(8, Math.max(1, req.maxSources ?? 5));

      const cacheKey = JSON.stringify({ q, max });
      const cached = answerCache.get(cacheKey);
      if (cached) return cached;

      const search = await runQueryInternal({ q });
      const top = search.results.slice(0, max);
      if (top.length === 0) {
        throw new Error("No search results found for query.");
      }

      // Fetch source pages in parallel; tolerate individual failures.
      const pages = await Promise.all(
        top.map((r) =>
          fetchPageCached(r.url).catch((err) => {
            logger.warn(`fetch ${r.url} failed:`, (err as Error).message);
            return null;
          }),
        ),
      );

      const citations: JoySearchCitation[] = [];
      const sourceBlocks: string[] = [];
      let idx = 0;
      for (let i = 0; i < top.length; i++) {
        const page = pages[i];
        const result = top[i];
        if (!page || !page.text) continue;
        idx += 1;
        citations.push({
          index: idx,
          url: result.url,
          title: result.title,
          displayUrl: result.displayUrl,
        });
        // Cap each source to keep total context under ~8k tokens.
        const excerpt = page.text.slice(0, 2400);
        sourceBlocks.push(
          `[${idx}] ${result.title}\n${result.displayUrl}\n${excerpt}`,
        );
      }
      if (citations.length === 0) {
        throw new Error("Could not fetch any source pages for the answer.");
      }

      const model = req.model || getDefaultModel();
      const started = Date.now();
      const userMsg = `Question: ${q}\n\n=== SOURCES ===\n\n${sourceBlocks.join("\n\n---\n\n")}`;

      const ollamaResp = await fetch(`${getOllamaApiUrl()}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          stream: false,
          options: { temperature: 0.2 },
          messages: [
            { role: "system", content: ANSWER_SYSTEM_PROMPT },
            { role: "user", content: userMsg },
          ],
        }),
      });
      if (!ollamaResp.ok) {
        throw new Error(`Ollama ${ollamaResp.status} ${ollamaResp.statusText}`);
      }
      const data = (await ollamaResp.json()) as { message?: { content?: string } };
      const content = data.message?.content?.trim() || "";
      if (!content) throw new Error("Answer returned empty response");

      // Split off the FOLLOW-UPS section.
      const followIdx = content.search(/\n\s*FOLLOW-?UPS:/i);
      const answer = followIdx === -1 ? content : content.slice(0, followIdx).trim();
      const followUps: string[] =
        followIdx === -1
          ? []
          : content
              .slice(followIdx)
              .split("\n")
              .map((l) => l.replace(/^\s*[-*]\s*/, "").trim())
              .filter((l) => l && !/^FOLLOW-?UPS:?$/i.test(l))
              .slice(0, 4);

      const resp: JoySearchAnswerResponse = {
        q,
        answer,
        citations,
        followUps,
        model,
        tookMs: Date.now() - started,
      };
      answerCache.set(cacheKey, resp, ANSWER_TTL);
      return resp;
    },
  );

  // ── joy-search:suggest ─────────────────────────────────────────────────
  handle(
    "joy-search:suggest",
    async (_e, req: JoySearchSuggestRequest): Promise<JoySearchSuggestResponse> => {
      const q = (req?.q || "").trim();
      if (!q) return { q: "", suggestions: [] };
      const cached = suggestCache.get(q);
      if (cached) return { q, suggestions: cached };
      const suggestions = await duckDuckGoSuggest(q).catch(() => [] as string[]);
      suggestCache.set(q, suggestions, SUGGEST_TTL);
      return { q, suggestions };
    },
  );
}

// ── Internal helper: run a query without going through IPC ────────────────

async function runQueryInternal(
  req: JoySearchQueryRequest,
): Promise<JoySearchQueryResponse> {
  const q = req.q.trim();
  const engines: JoySearchEngine[] =
    req.engines && req.engines.length > 0 ? req.engines : ["duckduckgo", "brave"];
  const cacheKey = JSON.stringify({
    q,
    p: req.page ?? 1,
    r: req.region ?? "",
    s: req.safe ?? "moderate",
    e: engines.slice().sort(),
    ai: !!req.aiRerank,
  });
  const cached = queryCache.get(cacheKey);
  if (cached) return cached;
  const hitLists = await Promise.all(engines.map((e) => runEngine(e, q, req)));
  const results = fuseAndRank(hitLists);
  const resp: JoySearchQueryResponse = {
    q,
    results,
    suggestions: [],
    intent: classifyIntent(q),
    enginesUsed: engines,
    tookMs: 0,
    cached: false,
  };
  queryCache.set(cacheKey, resp, QUERY_TTL);
  return resp;
}
