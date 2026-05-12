/**
 * Bot blueprint-command helpers — Telegram/Discord shortcut for the
 * Sovereign Blueprint Engine.
 *
 * Commands:
 *   /blueprint <intent...>          → compose + auto-run; reply with runId
 *   /blueprint_status <runId>       → show current status of a run
 *   /blueprint_runs                 → list the 5 most recent runs
 *   /blueprint_help                 → usage card
 *
 * Imports orchestrator + composer directly from main process — no IPC.
 */

import log from "electron-log";
import { composeBlueprint } from "@/lib/blueprint/composer";
import { getBlueprintOrchestrator } from "@/lib/blueprint/orchestrator";
import { getRun, listRuns } from "@/lib/blueprint/run_store";

const logger = log.scope("bot_blueprint_commands");

export interface BlueprintCommandMatch {
  command: "compose" | "status" | "runs" | "help";
  intent?: string;
  runId?: string;
  raw: string;
}

export function detectBlueprintCommand(text: string | undefined | null): BlueprintCommandMatch | null {
  if (!text) return null;
  const trimmed = text.trim();
  if (/^\/blueprint_help\b/i.test(trimmed)) return { command: "help", raw: trimmed };
  if (/^\/blueprint_runs\b/i.test(trimmed)) return { command: "runs", raw: trimmed };

  const status = trimmed.match(/^\/blueprint_status\s+([\w-]+)\b/i);
  if (status) return { command: "status", runId: status[1], raw: trimmed };

  const compose = trimmed.match(/^\/blueprint\s+(.+)$/is);
  if (compose) return { command: "compose", intent: compose[1].trim(), raw: trimmed };

  return null;
}

const HELP = [
  "🧠 *Sovereign Blueprint commands*",
  "",
  "/blueprint <what you want> — compose a multi-step automation (browser, scrape,",
  "  publish, attest, …) from natural language and run it with Whitehat verification.",
  "/blueprint_status <runId> — get the current state of a running blueprint.",
  "/blueprint_runs — list the 5 most recent runs.",
  "/blueprint_help — show this card.",
  "",
  "Example:",
  '  /blueprint Curate green-hydrogen pricing from the top 5 industry sites,',
  "  package as a verified ERC-1155 dataset, list it on the Joy Marketplace.",
].join("\n");

export async function runBlueprintCommand(match: BlueprintCommandMatch): Promise<string> {
  switch (match.command) {
    case "help":
      return HELP;

    case "runs": {
      const runs = await listRuns(5);
      if (runs.length === 0) return "No blueprint runs yet. Try /blueprint <intent>.";
      return [
        "🧠 Recent blueprint runs:",
        ...runs.map(
          (r) =>
            `• ${r.id.slice(0, 8)} — ${r.blueprintId} — ${r.status}` +
            (r.currentNodeId ? ` @ ${r.currentNodeId}` : "") +
            (r.error ? ` (err: ${r.error.slice(0, 80)})` : ""),
        ),
      ].join("\n");
    }

    case "status": {
      if (!match.runId) return "Usage: /blueprint_status <runId>";
      const run = await getRun(match.runId);
      if (!run) {
        // try prefix match
        const all = await listRuns(50);
        const hit = all.find((r) => r.id.startsWith(match.runId!));
        if (!hit) return `❌ Run ${match.runId} not found.`;
        return formatRun(hit);
      }
      return formatRun(run);
    }

    case "compose": {
      if (!match.intent) return "Usage: /blueprint <what you want to automate>";
      try {
        const composed = await composeBlueprint({ intent: match.intent });
        const runId = await getBlueprintOrchestrator().run({ yamlText: composed.yaml });
        return [
          `🧠 Blueprint composed and started`,
          `  id:      ${composed.blueprint.id}`,
          `  nodes:   ${composed.blueprint.nodes.length}`,
          `  runId:   ${runId}`,
          ``,
          `Track with: /blueprint_status ${runId.slice(0, 8)}`,
        ].join("\n");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("blueprint compose/run failed:", err);
        return `❌ Blueprint failed: ${msg}`;
      }
    }
  }
}

function formatRun(r: Awaited<ReturnType<typeof getRun>> & object): string {
  const lines = [
    `🧠 Blueprint run ${r.id.slice(0, 8)}`,
    `  blueprint: ${r.blueprintId} (v${r.blueprintVersion})`,
    `  status:    ${r.status}`,
  ];
  if (r.currentNodeId) lines.push(`  current:   ${r.currentNodeId}`);
  if (r.error) lines.push(`  error:     ${r.error.slice(0, 200)}`);
  const nodes = Object.entries(r.nodeState ?? {});
  if (nodes.length > 0) {
    lines.push("  nodes:");
    for (const [id, state] of nodes) {
      lines.push(`    • ${id}: ${state.status}${state.error ? ` (${state.error.slice(0, 60)})` : ""}`);
    }
  }
  return lines.join("\n");
}
