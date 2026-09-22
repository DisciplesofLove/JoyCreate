/**
 * web_search tool — Search the live web for up-to-date information.
 *
 * Wraps the keyless JoySearch engines (DuckDuckGo + Brave HTML) with
 * reciprocal-rank fusion. The agent uses this to research current docs, error
 * messages, library APIs, and best practices before writing code — grounding
 * its work in real, current sources instead of stale training data.
 *
 * Security: only fixed search-engine hosts are contacted; the user query is
 * URL-encoded into search params, so there is no SSRF surface here.
 */

import { z } from "zod";
import log from "electron-log";
import { ToolDefinition, escapeXmlContent } from "./types";
import { fuseAndRank, type EngineHit } from "@/lib/joy_search/fusion";
import { duckDuckGoSearch } from "@/lib/joy_search/engines/duckduckgo";
import { braveSearch } from "@/lib/joy_search/engines/brave";

const logger = log.scope("tool:web_search");

const webSearchSchema = z.object({
  query: z.string().min(1).describe("The web search query"),
  limit: z
    .number()
    .int()
    .positive()
    .max(15)
    .optional()
    .describe("Maximum number of results to return (default 6, max 15)."),
});

export const webSearchTool: ToolDefinition<z.infer<typeof webSearchSchema>> = {
  name: "web_search",
  description: `Search the live web for current information (docs, APIs, error messages, best practices, recent news).
Use this to ground your work in up-to-date sources before writing code or answering factual questions —
especially when the answer may have changed since your training cutoff, or when you need specific library/API details.
Returns ranked results (title, URL, snippet). Follow up with web_scraper if you need the full page content.`,
  inputSchema: webSearchSchema,
  defaultConsent: "always",

  getConsentPreview: (args) => `Search web: ${args.query}`,

  buildXml: (args, isComplete) => {
    if (!args.query) return undefined;
    let xml = `<joy-web-search>${escapeXmlContent(args.query)}`;
    if (isComplete) {
      xml += "</joy-web-search>";
    }
    return xml;
  },

  execute: async (args) => {
    const limit = args.limit ?? 6;
    logger.info(`web_search: "${args.query}" (limit ${limit})`);

    const hitLists: EngineHit[][] = [];

    // DuckDuckGo (keyless, primary). Brave is best-effort — tolerate failures
    // so a single engine outage never breaks search.
    const [ddg, brave] = await Promise.allSettled([
      duckDuckGoSearch(args.query, {}),
      braveSearch(args.query, {}),
    ]);
    if (ddg.status === "fulfilled" && ddg.value.length > 0) {
      hitLists.push(ddg.value);
    } else if (ddg.status === "rejected") {
      logger.warn(`DuckDuckGo failed: ${ddg.reason}`);
    }
    if (brave.status === "fulfilled" && brave.value.length > 0) {
      hitLists.push(brave.value);
    } else if (brave.status === "rejected") {
      logger.debug(`Brave failed: ${brave.reason}`);
    }

    if (hitLists.length === 0) {
      return "No web search results found (search engines returned nothing or were unreachable). Try rephrasing the query.";
    }

    const results = fuseAndRank(hitLists).slice(0, limit);
    if (results.length === 0) {
      return "No web search results found. Try rephrasing the query.";
    }

    const formatted = results
      .map(
        (r, i) =>
          `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet.replace(/\s+/g, " ").trim()}`,
      )
      .join("\n\n");

    return escapeXmlContent(
      `Web search results for "${args.query}":\n\n${formatted}`,
    );
  },
};
