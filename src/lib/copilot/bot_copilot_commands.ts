/**
 * Shared bridge between chat bots (Telegram, Discord, …) and the
 * Copilot service (`getCopilotService`).
 *
 * Bots use this to expose a `/copilot <prompt>` (or `!copilot <prompt>`)
 * slash-command that drives the full NLP router → tool/code-task pipeline.
 */

import log from "electron-log";
import { getCopilotService } from "@/lib/copilot/copilot_service";

const logger = log.scope("bot-copilot");

export interface CopilotCommandMatch {
  /** The prompt text after the slash trigger. */
  prompt: string;
}

/**
 * Detect a copilot slash command. Accepts:
 *   /copilot <prompt>     (Telegram-style)
 *   !copilot <prompt>     (Discord-style)
 *   /joy <prompt>         (alias)
 */
export function detectCopilotCommand(content: string): CopilotCommandMatch | null {
  const m = content.match(/^[/!](?:copilot|joy)(?:\s+([\s\S]+))?$/i);
  if (!m) return null;
  return { prompt: (m[1] ?? "").trim() };
}

/**
 * Run the prompt through the Copilot service and return a Markdown reply
 * suitable for Telegram or Discord. Never throws — returns an error string.
 */
export async function runCopilotCommand(
  match: CopilotCommandMatch,
  source: "telegram" | "discord",
): Promise<string> {
  if (!match.prompt) {
    return [
      "*Copilot help*",
      "",
      "Usage: `/copilot <what you want done>`",
      "",
      "Examples:",
      "• `/copilot list my recent peers`",
      "• `/copilot show federation stats`",
      "• `/copilot fix the failing telegram polling test` (code task — needs approval)",
      "",
      "Code tasks land in *awaiting-approval* — open the Copilot panel in JoyCreate to review the diff.",
    ].join("\n");
  }
  try {
    const service = getCopilotService();
    const { job } = await service.ask({ prompt: match.prompt });
    const lines: string[] = [];
    lines.push(`*Copilot job* \`${job.id.slice(0, 8)}\` — _${job.status}_`);
    if (job.kind) lines.push(`Kind: \`${job.kind}\``);
    if (job.summary) lines.push("", job.summary);
    if (job.output) {
      const trimmed = job.output.length > 1500 ? `${job.output.slice(0, 1500)}…` : job.output;
      lines.push("", trimmed);
    }
    if (job.status === "awaiting-approval") {
      lines.push(
        "",
        `⏸ Awaiting approval. Open JoyCreate → Copilot panel to review${job.branchName ? ` branch \`${job.branchName}\`` : ""}.`,
      );
    } else if (job.status === "failed" && job.errorMessage) {
      lines.push("", `❌ ${job.errorMessage}`);
    }
    return lines.join("\n");
  } catch (err) {
    logger.warn(`runCopilotCommand (${source}) failed:`, err);
    const msg = err instanceof Error ? err.message : String(err);
    return `❌ Copilot failed: ${msg}`;
  }
}
