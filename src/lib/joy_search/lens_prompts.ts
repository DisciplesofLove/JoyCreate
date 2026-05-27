/**
 * Lens prompts for JoySearch — one per JoySearchLensMode.
 *
 * Free-form lenses (summarize, eli5, explain, translate) return plain
 * text. Structured lenses (key-points, fact-check, pull-quotes) return
 * strict JSON so the UI can render them as rich components.
 */

import type { JoySearchLensMode } from "../../types/joy_search";

export interface LensSpec {
  /** System prompt for the model. */
  system: string;
  /** Build the user message from extracted article text + meta. */
  buildUser: (ctx: {
    title: string;
    url: string;
    text: string;
    targetLang?: string;
  }) => string;
  /** If true, request `format: "json"` from Ollama. */
  structured: boolean;
}

const ARTICLE_BLOCK = (title: string, url: string, text: string) =>
  `# ${title || "(no title)"}\nURL: ${url}\n\n---\n${text}`;

export const LENS_SPECS: Record<JoySearchLensMode, LensSpec> = {
  summarize: {
    system:
      "You are a precise, neutral summariser. Summarise the article in 4-6 short bullet points. Stay strictly grounded in the text — never invent facts. Use plain prose, no preamble.",
    buildUser: ({ title, url, text }) => ARTICLE_BLOCK(title, url, text),
    structured: false,
  },
  eli5: {
    system:
      "You explain web articles to a curious 12-year-old. Avoid jargon, use simple analogies, keep it under 150 words, and end with one sentence about why it matters.",
    buildUser: ({ title, url, text }) => ARTICLE_BLOCK(title, url, text),
    structured: false,
  },
  explain: {
    system:
      "You explain what a web article is about and the context a reader needs to understand it. Write 3 short paragraphs: (1) what it covers, (2) the key background a reader needs, (3) why it matters.",
    buildUser: ({ title, url, text }) => ARTICLE_BLOCK(title, url, text),
    structured: false,
  },
  translate: {
    system:
      "You are an expert translator. Translate the article content to the requested language, preserving meaning, headings, and list structure. Skip navigation/footer boilerplate. Output only the translation — no preamble.",
    buildUser: ({ title, url, text, targetLang }) =>
      `Target language: ${targetLang || "English"}\n\n${ARTICLE_BLOCK(title, url, text)}`,
    structured: false,
  },
  "key-points": {
    system: `Extract the 5-8 most important takeaways from an article as JSON.

Respond with ONLY a JSON object of this exact shape:
{ "keyPoints": [ { "point": string, "importance": "high"|"medium"|"low" } ] }

Each point must be one sentence, factual, and grounded in the article.`,
    buildUser: ({ title, url, text }) => ARTICLE_BLOCK(title, url, text),
    structured: true,
  },
  "fact-check": {
    system: `You identify verifiable factual claims in an article and assess each. Respond with ONLY a JSON object of this exact shape:
{ "claims": [ {
  "claim": string,            // verbatim or paraphrased claim
  "verdict": "supported"|"unsupported"|"needs-verification"|"false",
  "confidence": number,        // 0..1
  "reasoning": string          // one sentence explanation
} ] }

Only judge claims you can reason about from common knowledge. Use "needs-verification" liberally when uncertain. Include at most 6 claims.`,
    buildUser: ({ title, url, text }) => ARTICLE_BLOCK(title, url, text),
    structured: true,
  },
  "pull-quotes": {
    system: `Extract 3-5 of the most quotable, self-contained sentences from the article verbatim. Respond with ONLY a JSON object:
{ "quotes": [ { "quote": string, "context"?: string } ] }

Quotes must appear in the source text exactly. Add a short "context" only if needed for clarity.`,
    buildUser: ({ title, url, text }) => ARTICLE_BLOCK(title, url, text),
    structured: true,
  },
};

export const ANSWER_SYSTEM_PROMPT = `You are JoyCreate's grounded search assistant. The user asked a question; below are excerpts from the top web sources numbered [1], [2], etc.

Write a clear, direct answer (2-5 short paragraphs) that:
- synthesises across the sources
- includes inline citations like [1], [2] right after the facts they support
- says "I don't know" if the sources don't actually answer the question
- never invents facts not present in the sources

After the answer, on a new line, write:
FOLLOW-UPS:
- a short follow-up question the user might want next
- another follow-up question
- a third follow-up question`;

export function stripJsonFences(s: string): string {
  let out = s.trim();
  if (out.startsWith("```")) {
    out = out.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
  }
  const first = out.indexOf("{");
  const last = out.lastIndexOf("}");
  if (first !== -1 && last !== -1 && last > first) {
    out = out.slice(first, last + 1);
  }
  return out.trim();
}
