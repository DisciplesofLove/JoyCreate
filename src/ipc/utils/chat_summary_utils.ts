import { db } from "../../db";
import { chatSummaries } from "../../db/schema";
import { eq, sql } from "drizzle-orm";
import { generateText } from "ai";
import log from "electron-log";
import { readSettings } from "../../main/settings";
import { getModelClient } from "./get_model_client";

const logger = log.scope("chat_summary");

// Must match the verbatim window used by buildCompressedChatMessages in the
// chat stream pipeline (last 12 messages ≈ 6 turns are kept verbatim, so only
// older messages need to live in the rolling summary).
export const SUMMARY_KEEP_RECENT_MESSAGES = 12;

// Input/output caps for the background summarization call.
const MAX_INPUT_CHARS = 24_000;
const MAX_SUMMARY_OUTPUT_TOKENS = 900;

const SUMMARIZER_SYSTEM_PROMPT = `You maintain a cumulative memory of an app-building conversation between a user and an AI builder.
Given the EXISTING SUMMARY (may be empty) and NEW MESSAGES, produce ONE updated summary that replaces the existing one.
Preserve, in order of priority:
1. The original project intent and any constraints the user stated ("must", "don't", "always", style/stack choices).
2. Design decisions made and their reasons.
3. What has been built so far (features, key files) and what failed or was reverted, including error causes.
4. Unresolved requests or known issues.
Rules: plain markdown, use short bullet points grouped under "Intent & constraints", "Decisions", "Built so far", "Open items". Max ~400 words. Do not include code blocks. Do not invent details.`;

export interface StoredChatSummary {
  summary: string;
  upToMessageId: number;
}

/** Fetch the stored rolling summary for a chat, if any. */
export async function getStoredChatSummary(
  chatId: number,
): Promise<StoredChatSummary | null> {
  const row = await db.query.chatSummaries.findFirst({
    where: eq(chatSummaries.chatId, chatId),
  });
  if (!row?.summary) return null;
  return { summary: row.summary, upToMessageId: row.upToMessageId };
}

/** Replace bulky joy tag bodies so summarization input stays small. */
function compactMessageContent(content: string): string {
  return content
    .replace(
      /<joy-write\s+path="([^"]+)"[^>]*>[\s\S]*?<\/joy-write>/g,
      '[wrote file: $1]',
    )
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .replace(/<joy-command[\s\S]*?<\/joy-command>/g, "")
    .trim();
}

/**
 * Update the rolling summary for a chat in the background. Summarizes all
 * messages that (a) are older than the verbatim window and (b) are not yet
 * covered by the stored summary, folding them into a new cumulative summary.
 *
 * Never throws — failures are logged and the previous summary stays in place.
 */
export async function updateChatSummaryInBackground(
  chatId: number,
): Promise<void> {
  try {
    const chat = await db.query.chats.findFirst({
      where: (chats, { eq }) => eq(chats.id, chatId),
      with: {
        messages: {
          orderBy: (messages, { asc }) => [asc(messages.id)],
        },
      },
    });
    if (!chat || chat.messages.length <= SUMMARY_KEEP_RECENT_MESSAGES) {
      return; // Everything still fits in the verbatim window.
    }

    const existing = await getStoredChatSummary(chatId);
    const evicted = chat.messages.slice(0, -SUMMARY_KEEP_RECENT_MESSAGES);
    const uncovered = existing
      ? evicted.filter((m) => m.id > existing.upToMessageId)
      : evicted;
    if (uncovered.length === 0) return; // Summary is already up to date.

    let newMessagesText = uncovered
      .map((m) => `${m.role === "user" ? "USER" : "ASSISTANT"}: ${compactMessageContent(m.content)}`)
      .join("\n\n");
    if (newMessagesText.length > MAX_INPUT_CHARS) {
      newMessagesText =
        newMessagesText.slice(0, MAX_INPUT_CHARS) + "\n[input truncated]";
    }

    const settings = readSettings();
    const selection = settings.selectedModel ?? {
      provider: "auto",
      name: "auto",
    };
    const { modelClient } = await getModelClient(selection, settings);

    const prompt = `EXISTING SUMMARY:\n${existing?.summary ?? "(none)"}\n\nNEW MESSAGES:\n${newMessagesText}\n\nOutput the updated cumulative summary now.`;
    const result = await generateText({
      model: modelClient.model,
      system: SUMMARIZER_SYSTEM_PROMPT,
      prompt,
      temperature: 0.2,
      maxOutputTokens: MAX_SUMMARY_OUTPUT_TOKENS,
    });
    const summary = result.text.trim();
    if (!summary) {
      logger.warn(`Chat ${chatId}: summarizer returned empty text, skipping`);
      return;
    }

    const upToMessageId = uncovered[uncovered.length - 1].id;
    await db
      .insert(chatSummaries)
      .values({ chatId, upToMessageId, summary })
      .onConflictDoUpdate({
        target: chatSummaries.chatId,
        set: {
          upToMessageId,
          summary,
          updatedAt: sql`(unixepoch())`,
        },
      });
    logger.log(
      `Chat ${chatId}: rolling summary updated (covers up to message ${upToMessageId}, ${uncovered.length} new message(s) folded in)`,
    );
  } catch (error) {
    logger.warn(
      `Chat ${chatId}: background summary update failed (non-fatal):`,
      error,
    );
  }
}
