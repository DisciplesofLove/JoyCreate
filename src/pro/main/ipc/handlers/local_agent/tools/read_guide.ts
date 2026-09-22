/**
 * read_guide tool — Search and read the app's offline documentation hub.
 *
 * The user can import framework/library docs (React, Tailwind, Supabase, etc.)
 * into JoyCreate's Offline Docs Hub. This tool lets the agent search those docs
 * and read the most relevant guide inline — grounding its work in the exact
 * docs the user cares about, fully offline. Falls back gracefully when no docs
 * are imported.
 */

import { z } from "zod";
import log from "electron-log";
import { ToolDefinition, escapeXmlContent } from "./types";
import { getOfflineDocsHub } from "@/lib/offline_docs_hub";

const logger = log.scope("tool:read_guide");

const readGuideSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe(
      "What to look up in the offline docs (e.g. 'useEffect cleanup', 'supabase row level security').",
    ),
  read_top_result: z
    .boolean()
    .optional()
    .describe(
      "If true, return the full content of the single best-matching document instead of a list of snippets. Default false.",
    ),
});

const MAX_DOC_CHARS = 12000;

export const readGuideTool: ToolDefinition<z.infer<typeof readGuideSchema>> = {
  name: "read_guide",
  description: `Search the app's offline documentation hub for guides on frameworks/libraries the user has imported (React, Tailwind, Supabase, etc.).
Use this to ground your work in the exact docs the user relies on — fully offline.
- Default: returns ranked snippets (title + excerpt) matching your query.
- read_top_result: returns the full content of the single best match.
Returns a clear message when no docs are imported (then rely on web_search instead).`,
  inputSchema: readGuideSchema,
  defaultConsent: "always",

  getConsentPreview: (args) => `Read guide: ${args.query}`,

  buildXml: (args, isComplete) => {
    if (!args.query) return undefined;
    let xml = `<joy-output type="guide">${escapeXmlContent(args.query)}`;
    if (isComplete) {
      xml += "</joy-output>";
    }
    return xml;
  },

  execute: async (args) => {
    const hub = getOfflineDocsHub();
    try {
      await hub.initialize();
    } catch (err) {
      logger.debug(`Offline docs hub init: ${err}`);
    }

    const results = hub.search(args.query, { limit: 8 });
    if (results.length === 0) {
      return "No matching offline documentation found. The user may not have imported any docs into the Offline Docs Hub yet — use web_search for current information instead.";
    }

    if (args.read_top_result) {
      const top = results[0];
      const doc = hub.getDocument(top.docId);
      if (!doc) {
        return `Found a match (${top.title}) but could not load its content.`;
      }
      const content =
        doc.content.length > MAX_DOC_CHARS
          ? doc.content.slice(0, MAX_DOC_CHARS) + "\n\n…(truncated)"
          : doc.content;
      return escapeXmlContent(
        `# ${doc.title}\n_From collection: ${top.collectionName}_\n\n${content}`,
      );
    }

    const formatted = results
      .map((r, i) => {
        const snippet = r.snippet.replace(/<\/?mark>/g, "").replace(/\s+/g, " ").trim();
        return `${i + 1}. ${r.title} — ${r.collectionName}\n   ${snippet}`;
      })
      .join("\n\n");

    return escapeXmlContent(
      `Offline docs matching "${args.query}":\n\n${formatted}\n\nCall read_guide again with read_top_result=true to read the full top document.`,
    );
  },
};
