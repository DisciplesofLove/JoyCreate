/**
 * Domain reputation tables for JoySearch reranking.
 *
 * Scores in [0, 1]; multiplied into the fused score so that high-trust
 * domains float to the top for factual queries and SEO spam sinks.
 *
 * These are intentionally hand-curated and conservative. Tweak in PRs.
 */

const TIER_S: ReadonlyArray<RegExp> = [
  /(^|\.)wikipedia\.org$/i,
  /(^|\.)arxiv\.org$/i,
  /(^|\.)nih\.gov$/i,
  /(^|\.)nasa\.gov$/i,
  /\.edu$/i,
  /\.gov$/i,
];

const TIER_A: ReadonlyArray<RegExp> = [
  /(^|\.)mozilla\.org$/i,
  /(^|\.)developer\.mozilla\.org$/i,
  /(^|\.)docs\.[a-z0-9-]+\./i,
  /(^|\.)github\.com$/i,
  /(^|\.)stackoverflow\.com$/i,
  /(^|\.)reuters\.com$/i,
  /(^|\.)apnews\.com$/i,
  /(^|\.)bbc\.(co\.uk|com)$/i,
  /(^|\.)nature\.com$/i,
  /(^|\.)science\.org$/i,
  /(^|\.)who\.int$/i,
];

const TIER_B: ReadonlyArray<RegExp> = [
  /(^|\.)medium\.com$/i,
  /(^|\.)substack\.com$/i,
  /(^|\.)dev\.to$/i,
  /(^|\.)news\.ycombinator\.com$/i,
  /(^|\.)reddit\.com$/i,
];

const PENALISED: ReadonlyArray<RegExp> = [
  /(^|\.)pinterest\./i,
  /(^|\.)quora\.com$/i,
  /(^|\.)w3schools\.com$/i,
  /-?seo[-.]/i,
  /\.(top|xyz|click|loan|win|info)$/i,
];

/** Returns a multiplier in [0.5, 1.6]. 1.0 = neutral. */
export function reputationScore(hostname: string): number {
  const h = hostname.toLowerCase();
  if (TIER_S.some((r) => r.test(h))) return 1.6;
  if (TIER_A.some((r) => r.test(h))) return 1.35;
  if (TIER_B.some((r) => r.test(h))) return 1.05;
  if (PENALISED.some((r) => r.test(h))) return 0.55;
  return 1.0;
}
