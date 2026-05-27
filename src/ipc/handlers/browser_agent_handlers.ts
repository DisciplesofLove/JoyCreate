/**
 * Browser Agent IPC Handlers
 *
 * Channels:
 *   browser-agent:plan-step   → next BrowserAgentAction (asks the local LLM)
 *
 * The renderer owns the agent loop (it has to talk to the webview), but
 * planning runs in the main process so we can use the user's selected
 * model + the existing Ollama plumbing.
 */

import log from "electron-log";
import { createLoggedHandler } from "./safe_handle";
import { getOllamaApiUrl } from "./local_model_ollama_handler";
import { readSettings } from "../../main/settings";
import type {
  BrowserAgentAction,
  BrowserAgentActionType,
  BrowserAgentPlanRequest,
  BrowserAgentTurn,
} from "../../types/browser_agent";

const logger = log.scope("browser_agent_handlers");
const handle = createLoggedHandler(logger);

const VALID_ACTIONS: ReadonlySet<BrowserAgentActionType> = new Set([
  "navigate",
  "click",
  "fill",
  "press_key",
  "scroll",
  "extract",
  "wait",
  "back",
  "forward",
  "reload",
  "open_tab",
  "tool_call",
  "done",
]);

function buildSystemPrompt(allowedTools: string[]): string {
  return `You are JoyBrowser, an autonomous web-browsing agent operating inside the JoyCreate Smart Browser.

You drive a real browser tab through a strict plan/act/observe loop. After every action you receive an observation describing the current page (URL, title, body text, and a numbered list of interactive elements with their joy-aid indices). Use those indices when clicking or filling. Do NOT invent indices that aren't in the observation.

Output ONLY a single JSON object — no markdown, no commentary, no fences. Schema:
{
  "thought": "one short sentence — what you intend to do next and why",
  "action": "navigate" | "click" | "fill" | "press_key" | "scroll" | "extract" | "wait" | "back" | "forward" | "reload" | "open_tab" | "tool_call" | "done",
  "params": { ... action-specific },
  "done": false,
  "answer": "set only when action='done' — the final reply to the user"
}

Action parameters:
- navigate: { "url": string }                       — load url in the current tab
- click: { "index": number }                        — click element by joy-aid index
- fill: { "index": number, "value": string }        — fill an input/textarea/contenteditable
- press_key: { "key": string, "index"?: number }    — dispatch a keyboard event ("Enter", "ArrowDown", ...)
- scroll: { "direction": "up"|"down"|"top"|"bottom", "amount"?: number }
- extract: { "selector"?: string }                  — return text under a CSS selector (default: body)
- wait: { "ms": number }                            — pause; use after navigation if page is still loading
- back / forward / reload: {}                       — history controls
- open_tab: { "url": string }                       — open a new tab in background
- tool_call: { "name": string, "args": object }     — invoke a JoyCreate tool (see allowed list below)
- done: {} with top-level "answer" set             — STOP and reply to the user

Allowed tools for tool_call: ${allowedTools.length ? allowedTools.join(", ") : "(none)"}.

Rules:
1. Plan ONE step at a time. Never batch.
2. Prefer click/fill/extract over navigate when you're already on the right page.
3. If you fill a search box, follow with press_key {key:"Enter"} or click the submit button.
4. After navigate/click that loads a page, the next step is usually wait {ms: 800} or extract.
5. NEVER fabricate facts. If the answer isn't on the page, navigate or search until it is.
6. End with action="done" and a clear final answer when the user's task is complete.
7. If a captcha, login wall, paywall, or destructive operation appears, finish with action="done" and explain.`;
}

function trimHistoryForPrompt(history: BrowserAgentTurn[]): string {
  // Keep the last 6 turns at most; older steps get a one-line summary.
  const last = history.slice(-6);
  const older = history.slice(0, -6);
  const parts: string[] = [];
  if (older.length) {
    parts.push(
      `[Older steps omitted: ${older.length} actions, ending at step ${older[older.length - 1].step}]`,
    );
  }
  for (const t of last) {
    const obs = t.observation;
    parts.push(
      `STEP ${t.step}\n  action: ${t.action.action} ${
        t.action.params ? JSON.stringify(t.action.params) : ""
      }\n  thought: ${t.action.thought ?? ""}\n  result: ${
        obs ? obs.result : "(no observation)"
      }${obs ? `\n  url: ${obs.url}` : ""}`,
    );
  }
  return parts.join("\n");
}

function buildUserPrompt(req: BrowserAgentPlanRequest): string {
  const obs = req.observation;
  const elementsList = obs.elements
    .map(
      (e) =>
        `  [${e.i}] <${e.t}${e.r ? ` role=${e.r}` : ""}>${
          e.text ? ` "${e.text}"` : ""
        }${e.value ? ` value=${JSON.stringify(e.value)}` : ""}${
          e.href ? ` href=${e.href}` : ""
        }${e.inView ? "" : " (offscreen)"}`,
    )
    .join("\n");

  return [
    `USER TASK:\n${req.task}`,
    ``,
    `HISTORY:\n${trimHistoryForPrompt(req.history) || "(no actions yet)"}`,
    ``,
    `CURRENT PAGE — step ${obs.step}`,
    `URL: ${obs.url}`,
    `Title: ${obs.title}`,
    ``,
    `INTERACTIVE ELEMENTS (by joy-aid index):`,
    elementsList || "  (none visible)",
    ``,
    `PAGE TEXT (truncated):`,
    obs.text || "(empty)",
    ``,
    `Respond with the next JSON action only.`,
  ].join("\n");
}

function stripJsonFences(s: string): string {
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

async function planNextAction(
  req: BrowserAgentPlanRequest,
): Promise<BrowserAgentAction> {
  const settings = readSettings();
  const model = req.model || settings.selectedModel?.name || "qwen2.5-coder:7b";
  const system = buildSystemPrompt(req.allowedTools);
  const user = buildUserPrompt(req);

  const resp = await fetch(`${getOllamaApiUrl()}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      stream: false,
      format: "json",
      options: { temperature: 0.2 },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  if (!resp.ok) {
    throw new Error(`Ollama returned ${resp.status} ${resp.statusText}`);
  }
  const data = (await resp.json()) as { message?: { content?: string } };
  const content = data.message?.content?.trim();
  if (!content) throw new Error("Agent planner returned empty response");

  let parsed: BrowserAgentAction;
  try {
    parsed = JSON.parse(stripJsonFences(content));
  } catch (err) {
    logger.error("Agent planner JSON parse failed. Raw:", content);
    throw new Error(
      `Agent planner did not return valid JSON: ${(err as Error).message}`,
    );
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Agent planner returned non-object");
  }
  if (!VALID_ACTIONS.has(parsed.action as BrowserAgentActionType)) {
    throw new Error(`Agent planner returned unknown action "${parsed.action}"`);
  }
  return parsed;
}

export function registerBrowserAgentHandlers(): void {
  logger.info("Registering Browser Agent IPC handlers");

  handle(
    "browser-agent:plan-step",
    async (_evt, req: BrowserAgentPlanRequest): Promise<BrowserAgentAction> => {
      if (!req?.task?.trim()) throw new Error("Agent task is required");
      if (!req.observation) throw new Error("Agent observation is required");
      return planNextAction(req);
    },
  );
}
