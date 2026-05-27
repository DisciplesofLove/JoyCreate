/**
 * Type definitions for JoySearch — local-AI-powered web search.
 *
 * All shapes are shared between the main-process handlers and the
 * renderer-side client/hooks. Keep these JSON-serialisable.
 */

export type JoySearchEngine = "duckduckgo" | "brave";

export interface JoySearchResult {
  /** 1-based final rank after fusion + reputation reranking. */
  rank: number;
  title: string;
  url: string;
  /** Hostname without trailing slash, for grouping/display. */
  displayUrl: string;
  /** Short snippet, may be enriched from page metadata. */
  snippet: string;
  faviconUrl: string;
  /** Engines that returned this URL, in fusion order. */
  sources: JoySearchEngine[];
  /** Optional reputation score 0..1 (higher = more trusted). */
  reputation?: number;
}

export interface JoySearchAnswerBox {
  source: string;
  url: string;
  text: string;
}

export interface JoySearchQueryRequest {
  q: string;
  page?: number;
  region?: string;
  /** "off" | "moderate" | "strict" */
  safe?: "off" | "moderate" | "strict";
  /** Subset of engines to use; default = all enabled in settings. */
  engines?: JoySearchEngine[];
  /** If true, run a local-AI rerank on the top 20 raw results. */
  aiRerank?: boolean;
}

export interface JoySearchQueryResponse {
  q: string;
  results: JoySearchResult[];
  suggestions: string[];
  answerBox?: JoySearchAnswerBox;
  /** Lightweight intent classification (heuristic). */
  intent: JoySearchIntent;
  /** Engines actually used (after settings filtering). */
  enginesUsed: JoySearchEngine[];
  tookMs: number;
  cached: boolean;
}

export type JoySearchIntent =
  | "factual"
  | "navigational"
  | "shopping"
  | "how-to"
  | "news"
  | "code"
  | "general";

export interface JoySearchFetchPageRequest {
  url: string;
}

export interface JoySearchFetchPageResponse {
  url: string;
  finalUrl: string;
  title: string;
  /** Main article text, boilerplate removed, capped. */
  text: string;
  byline?: string;
  excerpt?: string;
  lang?: string;
  /** UTC ms when we fetched this. */
  fetchedAt: number;
  /** Cached hit? */
  cached: boolean;
}

export type JoySearchLensMode =
  | "summarize"
  | "key-points"
  | "fact-check"
  | "pull-quotes"
  | "translate"
  | "eli5"
  | "explain";

export interface JoySearchLensRequest {
  url: string;
  mode: JoySearchLensMode;
  /** Required for "translate" — ISO language name or code (e.g. "Spanish"). */
  targetLang?: string;
  /** Override Ollama model. */
  model?: string;
}

export interface JoySearchKeyPoint {
  point: string;
  importance: "high" | "medium" | "low";
}

export interface JoySearchFactClaim {
  claim: string;
  verdict: "supported" | "unsupported" | "needs-verification" | "false";
  confidence: number;
  reasoning: string;
}

export interface JoySearchPullQuote {
  quote: string;
  context?: string;
}

export interface JoySearchLensResponse {
  url: string;
  mode: JoySearchLensMode;
  /** Plain-text result for free-form lenses (summarize/translate/eli5/explain). */
  text?: string;
  /** Structured result for the structured lenses. */
  keyPoints?: JoySearchKeyPoint[];
  claims?: JoySearchFactClaim[];
  quotes?: JoySearchPullQuote[];
  model: string;
  tookMs: number;
}

export interface JoySearchAnswerRequest {
  q: string;
  /** Max source pages to ingest. Default 5. */
  maxSources?: number;
  model?: string;
}

export interface JoySearchCitation {
  index: number;
  url: string;
  title: string;
  displayUrl: string;
}

export interface JoySearchAnswerResponse {
  q: string;
  answer: string;
  citations: JoySearchCitation[];
  followUps: string[];
  model: string;
  tookMs: number;
}

export interface JoySearchSuggestRequest {
  q: string;
}

export interface JoySearchSuggestResponse {
  q: string;
  suggestions: string[];
}
