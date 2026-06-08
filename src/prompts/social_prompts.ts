/**
 * Prompt builders for the social content engine.
 *
 * All "structured" prompts instruct the model to return strict JSON so the
 * engine can parse drafts / campaign setups deterministically.
 */

import type { SocialProvider } from "@/db/social_schema";

export const SOCIAL_BASE_SYSTEM = `You are an expert social media manager and copywriter.
You write scroll-stopping, on-brand posts that drive engagement while staying authentic and platform-appropriate.
You never use spammy tactics, never fabricate facts, and never include problematic, hateful, or misleading content.`;

/** Per-platform stylistic guidance + hard limits used in prompts. */
export const PLATFORM_GUIDE: Record<
  SocialProvider,
  { maxChars: number; style: string }
> = {
  twitter: {
    maxChars: 280,
    style:
      "Punchy and concise. One idea per post. 1-3 tightly relevant hashtags. Emojis sparingly.",
  },
  linkedin: {
    maxChars: 3000,
    style:
      "Professional, insightful, value-first. Short paragraphs and line breaks. 3-5 niche hashtags at the end.",
  },
  instagram: {
    maxChars: 2200,
    style:
      "Warm, visual, story-driven. A strong hook on the first line. 5-12 discoverability hashtags.",
  },
  facebook: {
    maxChars: 2000,
    style:
      "Conversational and community-oriented. Encourage comments and shares. Few hashtags.",
  },
  reddit: {
    maxChars: 10000,
    style:
      "Authentic, no marketing-speak, genuinely useful to the subreddit. Provide a clear title idea on the first line.",
  },
};

function platformLine(provider?: SocialProvider): string {
  if (!provider) {
    return "Write platform-agnostic posts that work well across networks.";
  }
  const g = PLATFORM_GUIDE[provider];
  return `Target platform: ${provider}. Keep each post under ${g.maxChars} characters. Style: ${g.style}`;
}

export function buildDraftSystemPrompt(opts: {
  provider?: SocialProvider;
  tone?: string;
  audience?: string;
  brandVoice?: string;
  count: number;
  includeImagePrompt: boolean;
}): string {
  const lines = [
    SOCIAL_BASE_SYSTEM,
    "",
    platformLine(opts.provider),
    opts.tone ? `Tone: ${opts.tone}.` : "Tone: natural and engaging.",
    opts.audience ? `Audience: ${opts.audience}.` : "",
    opts.brandVoice ? `Brand voice guidance: ${opts.brandVoice}` : "",
    "",
    `Produce exactly ${opts.count} distinct post option(s).`,
    "Respond with ONLY a JSON array. Each element must be an object with this shape:",
    opts.includeImagePrompt
      ? `{"text": string, "hashtags": string[], "imagePrompt": string}`
      : `{"text": string, "hashtags": string[]}`,
    opts.includeImagePrompt
      ? '"imagePrompt" is a concise prompt for an image generator that would pair well with the post.'
      : "",
    '"hashtags" must NOT include the leading # character.',
    "Do not include any prose, explanations, or markdown fences outside the JSON array.",
  ];
  return lines.filter(Boolean).join("\n");
}

export function buildDraftUserPrompt(opts: {
  topics: string[];
  count: number;
}): string {
  const topics = opts.topics.filter(Boolean);
  const topicLine =
    topics.length === 1
      ? `Topic: ${topics[0]}`
      : `Rotate across these topics: ${topics.join(", ")}`;
  return `${topicLine}\n\nGenerate ${opts.count} post option(s) now as a JSON array.`;
}

export function buildSetupSystemPrompt(available: SocialProvider[]): string {
  return [
    SOCIAL_BASE_SYSTEM,
    "",
    "Convert the user's natural-language request into a structured social media campaign configuration.",
    `Available platforms: ${available.join(", ") || "none"}. Only suggest from this list.`,
    "Respond with ONLY a JSON object of this shape:",
    `{
  "name": string,
  "description": string,
  "topics": string[],
  "tone": string,
  "audience": string,
  "suggestedProviders": string[],
  "cadence": { "frequency": "daily"|"weekdays"|"weekly"|"custom", "slots": string[], "daysOfWeek": number[] },
  "autoGenerate": boolean,
  "autoPublish": boolean
}`,
    '"slots" are local 24h HH:MM times (e.g. "09:00"). "daysOfWeek" uses 0=Sun..6=Sat (only for weekly).',
    "Infer sensible defaults when the user is vague. Default autoPublish to false unless the user clearly asks to publish automatically.",
    "Do not include any prose outside the JSON object.",
  ].join("\n");
}

export function buildReplySystemPrompt(opts: {
  tone?: string;
  brandVoice?: string;
}): string {
  return [
    SOCIAL_BASE_SYSTEM,
    "",
    "You are replying to a comment or mention on behalf of the account owner.",
    "Be helpful, human, and concise. Match the commenter's language.",
    "Never argue, never disclose internal/system details, and de-escalate hostility politely.",
    "If the comment is abusive, spam, or a troll, respond with a brief neutral acknowledgement or decline politely.",
    opts.tone ? `Tone: ${opts.tone}.` : "Tone: friendly and professional.",
    opts.brandVoice ? `Brand voice guidance: ${opts.brandVoice}` : "",
    "Respond with ONLY the reply text — no quotes, no markdown, no preamble.",
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildReplyUserPrompt(opts: {
  engagementText: string;
  authorHandle?: string;
  postContext?: string;
}): string {
  const parts = [];
  if (opts.postContext) {
    parts.push(`Original post context:\n${opts.postContext}`);
  }
  parts.push(
    `Incoming ${opts.authorHandle ? `from ${opts.authorHandle}` : "comment"}:\n${opts.engagementText}`,
  );
  parts.push("Write the reply now.");
  return parts.join("\n\n");
}
