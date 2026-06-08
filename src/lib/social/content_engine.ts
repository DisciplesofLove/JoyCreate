/**
 * Social content engine.
 *
 * AI-assisted helpers for the social suite:
 *   - generatePostDrafts:        topic(s) → on-brand post options
 *   - parseNaturalLanguageSetup: free text → structured campaign config
 *   - suggestReply:              comment → drafted reply
 *   - planCampaignCalendar:      cadence → concrete future post slots (pure)
 *
 * Text generation routes through the app's configured language model via
 * `getModelClient`. A `ContentEngineDeps` override lets tests inject a fake
 * completion function so no real model is required.
 */

import { generateText } from "ai";
import log from "electron-log";

import type {
  SocialCampaignCadence,
  SocialProvider,
} from "@/db/social_schema";
import { getModelClient } from "@/ipc/utils/get_model_client";
import { readSettings } from "@/main/settings";
import {
  buildDraftSystemPrompt,
  buildDraftUserPrompt,
  buildReplySystemPrompt,
  buildReplyUserPrompt,
  buildSetupSystemPrompt,
} from "@/prompts/social_prompts";

const logger = log.scope("social:content_engine");

export interface GeneratedDraft {
  text: string;
  hashtags: string[];
  imagePrompt?: string;
}

export interface ParsedCampaignSetup {
  name: string;
  description?: string;
  topics: string[];
  tone?: string;
  audience?: string;
  suggestedProviders: SocialProvider[];
  cadence: SocialCampaignCadence;
  autoGenerate: boolean;
  autoPublish: boolean;
}

export interface PlannedSlot {
  scheduledFor: number;
  topic: string;
}

export interface ContentEngineDeps {
  /** Override the LLM call (used by tests). */
  complete?: (args: {
    system: string;
    prompt: string;
    temperature?: number;
    maxTokens?: number;
  }) => Promise<string>;
}

const ALL_PROVIDERS: SocialProvider[] = [
  "twitter",
  "linkedin",
  "instagram",
  "facebook",
  "reddit",
];

async function complete(
  args: {
    system: string;
    prompt: string;
    temperature?: number;
    maxTokens?: number;
  },
  deps?: ContentEngineDeps,
): Promise<string> {
  if (deps?.complete) return deps.complete(args);
  const settings = readSettings();
  const selection = settings.selectedModel ?? { provider: "auto", name: "auto" };
  const { modelClient } = await getModelClient(selection, settings);
  const result = await generateText({
    model: modelClient.model,
    system: args.system,
    prompt: args.prompt,
    temperature: args.temperature ?? 0.8,
    maxOutputTokens: args.maxTokens ?? 1024,
  });
  return result.text ?? "";
}

/** Best-effort JSON extraction tolerant of code fences and stray prose. */
export function extractJson<T>(text: string): T {
  let t = (text ?? "").trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const firstObj = t.indexOf("{");
  const firstArr = t.indexOf("[");
  let start: number;
  if (firstArr === -1) start = firstObj;
  else if (firstObj === -1) start = firstArr;
  else start = Math.min(firstObj, firstArr);
  if (start === -1) throw new Error("No JSON found in model output.");
  const open = t[start];
  const close = open === "[" ? "]" : "}";
  const end = t.lastIndexOf(close);
  if (end === -1 || end < start) {
    throw new Error("Malformed JSON in model output.");
  }
  return JSON.parse(t.slice(start, end + 1)) as T;
}

/** Generate on-brand post drafts for one or more topics. */
export async function generatePostDrafts(
  opts: {
    topics: string[];
    provider?: SocialProvider;
    tone?: string;
    audience?: string;
    brandVoice?: string;
    count?: number;
    includeImagePrompt?: boolean;
  },
  deps?: ContentEngineDeps,
): Promise<GeneratedDraft[]> {
  const topics = opts.topics.map((t) => t.trim()).filter(Boolean);
  if (topics.length === 0) {
    throw new Error("At least one topic is required to generate drafts.");
  }
  const count = Math.min(Math.max(opts.count ?? 3, 1), 10);
  const includeImagePrompt = opts.includeImagePrompt ?? true;
  const system = buildDraftSystemPrompt({
    provider: opts.provider,
    tone: opts.tone,
    audience: opts.audience,
    brandVoice: opts.brandVoice,
    count,
    includeImagePrompt,
  });
  const prompt = buildDraftUserPrompt({ topics, count });
  const raw = await complete(
    { system, prompt, temperature: 0.9, maxTokens: 1600 },
    deps,
  );
  const parsed = extractJson<
    Array<{ text?: string; hashtags?: unknown; imagePrompt?: unknown }>
  >(raw);
  if (!Array.isArray(parsed)) {
    throw new Error("Model did not return a list of drafts.");
  }
  return parsed
    .filter((d) => d && typeof d.text === "string" && d.text.trim().length > 0)
    .slice(0, count)
    .map((d) => ({
      text: (d.text as string).trim(),
      hashtags: Array.isArray(d.hashtags)
        ? d.hashtags.map((h) => String(h).replace(/^#/, "")).filter(Boolean)
        : [],
      imagePrompt:
        typeof d.imagePrompt === "string" && d.imagePrompt.trim()
          ? d.imagePrompt.trim()
          : undefined,
    }));
}

function normalizeCadence(input: unknown): SocialCampaignCadence {
  const c = (input ?? {}) as Partial<SocialCampaignCadence>;
  const frequency =
    c.frequency === "daily" ||
    c.frequency === "weekdays" ||
    c.frequency === "weekly" ||
    c.frequency === "custom"
      ? c.frequency
      : "weekdays";
  const slots =
    Array.isArray(c.slots) && c.slots.length > 0
      ? c.slots.filter((s) => /^\d{1,2}:\d{2}$/.test(String(s)))
      : ["09:00"];
  const daysOfWeek = Array.isArray(c.daysOfWeek)
    ? c.daysOfWeek
        .map((n) => Number(n))
        .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6)
    : undefined;
  return {
    frequency,
    slots: slots.length ? slots : ["09:00"],
    daysOfWeek,
    cron: typeof c.cron === "string" ? c.cron : undefined,
    timezone: typeof c.timezone === "string" ? c.timezone : undefined,
  };
}

/** Turn a free-text instruction into a structured campaign configuration. */
export async function parseNaturalLanguageSetup(
  instruction: string,
  ctx?: { availableProviders?: SocialProvider[] },
  deps?: ContentEngineDeps,
): Promise<ParsedCampaignSetup> {
  if (!instruction || !instruction.trim()) {
    throw new Error("An instruction is required.");
  }
  const available = ctx?.availableProviders?.length
    ? ctx.availableProviders
    : ALL_PROVIDERS;
  const system = buildSetupSystemPrompt(available);
  const raw = await complete(
    { system, prompt: instruction.trim(), temperature: 0.4, maxTokens: 900 },
    deps,
  );
  const p = extractJson<Partial<ParsedCampaignSetup>>(raw);

  const topics = Array.isArray(p.topics)
    ? p.topics.map((t) => String(t).trim()).filter(Boolean)
    : [];
  const suggested = Array.isArray(p.suggestedProviders)
    ? (p.suggestedProviders
        .map((s) => String(s).toLowerCase())
        .filter((s) =>
          (available as string[]).includes(s),
        ) as SocialProvider[])
    : [];
  return {
    name:
      typeof p.name === "string" && p.name.trim()
        ? p.name.trim()
        : topics[0]
          ? `${topics[0]} campaign`
          : "New campaign",
    description:
      typeof p.description === "string" ? p.description.trim() : undefined,
    topics: topics.length ? topics : ["general updates"],
    tone: typeof p.tone === "string" ? p.tone.trim() : undefined,
    audience: typeof p.audience === "string" ? p.audience.trim() : undefined,
    suggestedProviders: suggested,
    cadence: normalizeCadence(p.cadence),
    autoGenerate: Boolean(p.autoGenerate),
    autoPublish: Boolean(p.autoPublish),
  };
}

/** Draft a reply to an inbound engagement. */
export async function suggestReply(
  opts: {
    engagementText: string;
    authorHandle?: string;
    postContext?: string;
    tone?: string;
    brandVoice?: string;
  },
  deps?: ContentEngineDeps,
): Promise<string> {
  if (!opts.engagementText || !opts.engagementText.trim()) {
    throw new Error("Nothing to reply to.");
  }
  const system = buildReplySystemPrompt({
    tone: opts.tone,
    brandVoice: opts.brandVoice,
  });
  const prompt = buildReplyUserPrompt({
    engagementText: opts.engagementText,
    authorHandle: opts.authorHandle,
    postContext: opts.postContext,
  });
  const raw = await complete(
    { system, prompt, temperature: 0.7, maxTokens: 400 },
    deps,
  );
  return raw
    .trim()
    .replace(/^```[\s\S]*?\n/, "")
    .replace(/```$/, "")
    .replace(/^["']|["']$/g, "")
    .trim();
}

/**
 * Expand a cadence into concrete future post timestamps. Pure / deterministic
 * (no LLM), so it is fully unit-testable. Topics are assigned round-robin.
 */
export function planCampaignCalendar(opts: {
  cadence: SocialCampaignCadence;
  fromMs: number;
  count: number;
  topics: string[];
}): PlannedSlot[] {
  const { cadence, fromMs, count } = opts;
  const topics = opts.topics.filter(Boolean);
  const slots = cadence.slots?.length ? cadence.slots : ["09:00"];
  const out: PlannedSlot[] = [];

  const allowedDow = (dow: number): boolean => {
    if (cadence.frequency === "weekdays") return dow >= 1 && dow <= 5;
    if (cadence.frequency === "weekly") {
      const days = cadence.daysOfWeek?.length ? cadence.daysOfWeek : [1];
      return days.includes(dow);
    }
    return true; // daily / custom
  };

  const from = new Date(fromMs);
  const cursor = new Date(
    from.getFullYear(),
    from.getMonth(),
    from.getDate(),
    0,
    0,
    0,
    0,
  );
  let topicIdx = 0;
  let safety = 0;
  while (out.length < count && safety < 366 * 3) {
    safety++;
    if (allowedDow(cursor.getDay())) {
      for (const slot of slots) {
        if (out.length >= count) break;
        const [h, m] = slot.split(":").map((n) => Number.parseInt(n, 10));
        const when = new Date(
          cursor.getFullYear(),
          cursor.getMonth(),
          cursor.getDate(),
          Number.isFinite(h) ? h : 9,
          Number.isFinite(m) ? m : 0,
          0,
          0,
        );
        if (when.getTime() > fromMs) {
          out.push({
            scheduledFor: when.getTime(),
            topic: topics.length ? topics[topicIdx % topics.length] : "",
          });
          topicIdx++;
        }
      }
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  logger.debug(`planned ${out.length}/${count} slots`);
  return out;
}
