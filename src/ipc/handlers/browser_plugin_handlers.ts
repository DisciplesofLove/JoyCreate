/**
 * Browser Plugin IPC Handlers
 *
 * Persists user-defined / AI-generated browser plugins to a JSON file in
 * the Electron userData directory and exposes CRUD + an AI-builder
 * endpoint that asks the user's selected local model to generate a plugin
 * spec from a natural-language description.
 *
 * Channels:
 *   browser-plugins:list       → BrowserPlugin[]
 *   browser-plugins:save       → BrowserPlugin     (create or upsert by id)
 *   browser-plugins:delete     → { id }            → { ok: true }
 *   browser-plugins:toggle     → { id, enabled }   → BrowserPlugin
 *   browser-plugins:build      → BuildBrowserPluginRequest → BrowserPlugin (unsaved)
 */

import log from "electron-log";
import path from "node:path";
import { promises as fs } from "node:fs";
import { app } from "electron";
import { createLoggedHandler } from "./safe_handle";
import { getOllamaApiUrl } from "./local_model_ollama_handler";
import { readSettings } from "../../main/settings";
import type {
  BrowserPlugin,
  BrowserPluginType,
  BuildBrowserPluginRequest,
  CreateBrowserPluginRequest,
  UpdateBrowserPluginRequest,
} from "../../types/browser_plugin";

const logger = log.scope("browser_plugin_handlers");
const handle = createLoggedHandler(logger);

// ── Storage ───────────────────────────────────────────────────────────────

function getStorePath(): string {
  return path.join(app.getPath("userData"), "browser-plugins.json");
}

interface StoreFile {
  plugins: BrowserPlugin[];
  version: 1;
}

const BUILTIN_PLUGINS: BrowserPlugin[] = [
  {
    id: "builtin-summarize-selection",
    name: "Summarize Selection",
    description:
      "Reads the user's current text selection and asks the AI to summarize it.",
    type: "page-action",
    code: `(() => { const s = window.getSelection?.().toString() || ''; return s.trim() || null; })()`,
    promptTemplate:
      "Summarize the following selected text from {{url}} in 3-5 bullet points:\n\n{{result}}",
    icon: "Highlighter",
    enabled: true,
    builtin: true,
    author: "joycreate",
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: "builtin-extract-links",
    name: "Extract Links",
    description: "Lists every external link on the current page.",
    type: "page-action",
    code: `(() => Array.from(document.querySelectorAll('a[href^="http"]')).map(a => ({text: (a.textContent||'').trim().slice(0,80), href: a.href})).slice(0,200))()`,
    promptTemplate:
      "Here are the links found on {{title}} ({{url}}). Group them by topic and highlight any that look suspicious:\n\n{{result}}",
    icon: "Link",
    enabled: true,
    builtin: true,
    author: "joycreate",
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: "builtin-meta-info",
    name: "Page Metadata",
    description: "Pulls Open Graph and meta tags from the current page.",
    type: "widget",
    code: `(() => { const out = {}; document.querySelectorAll('meta').forEach(m => { const k = m.getAttribute('property') || m.getAttribute('name'); const v = m.getAttribute('content'); if (k && v) out[k] = v; }); return out; })()`,
    icon: "Tags",
    enabled: true,
    builtin: true,
    author: "joycreate",
    createdAt: 0,
    updatedAt: 0,
  },
];

async function readStore(): Promise<StoreFile> {
  const file = getStorePath();
  try {
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw) as StoreFile;
    if (!parsed.plugins || !Array.isArray(parsed.plugins)) {
      return { version: 1, plugins: [...BUILTIN_PLUGINS] };
    }
    // Ensure builtins are always present (allow user to toggle them off,
    // not delete them).
    const byId = new Map(parsed.plugins.map((p) => [p.id, p]));
    for (const b of BUILTIN_PLUGINS) {
      if (!byId.has(b.id)) parsed.plugins.push(b);
    }
    return parsed;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      logger.warn("Failed to read browser plugin store, seeding builtins:", err);
    }
    return { version: 1, plugins: [...BUILTIN_PLUGINS] };
  }
}

async function writeStore(store: StoreFile): Promise<void> {
  const file = getStorePath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(store, null, 2), "utf8");
}

function makeId(): string {
  return `plugin-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

// ── AI builder ────────────────────────────────────────────────────────────

const BUILDER_SYSTEM_PROMPT = `You design tiny browser plugins for the JoyCreate Smart Browser.

Each plugin has:
- name (1–4 words, Title Case)
- description (one short sentence)
- type: "page-action" | "widget" | "command"
- code: A SINGLE JavaScript IIFE expression that runs inside the active web page (via webview.executeJavaScript). It MUST be a self-contained expression (parenthesised arrow function called immediately) that returns a JSON-serializable value (string | object | array). NEVER access window.require, Node APIs, or chrome.*. Keep it under 80 lines.
- promptTemplate (optional): a Mustache-style template that will be appended to the AI prompt. Available variables: {{result}} (the code's return value as JSON or string), {{url}}, {{title}}.
- icon (optional): a Lucide icon name such as "Sparkles", "Search", "Globe", "Tags", "Wand2".

Respond with ONLY a single JSON object — no markdown, no commentary, no fences. Schema:
{ "name": string, "description": string, "type": "page-action"|"widget"|"command", "code": string, "promptTemplate"?: string, "icon"?: string }`;

function stripJsonFences(s: string): string {
  let out = s.trim();
  if (out.startsWith("```")) {
    out = out.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
  }
  // Sometimes models prepend prose — find the first { and last }.
  const first = out.indexOf("{");
  const last = out.lastIndexOf("}");
  if (first !== -1 && last !== -1 && last > first) {
    out = out.slice(first, last + 1);
  }
  return out.trim();
}

async function buildPluginWithOllama(
  req: BuildBrowserPluginRequest,
): Promise<BrowserPlugin> {
  const settings = readSettings();
  const model =
    req.model || settings.selectedModel?.name || "qwen2.5-coder:7b";

  const userMsg = [
    `Design a browser plugin that does the following:`,
    `"${req.description.trim()}"`,
    req.currentUrl ? `The user is currently on: ${req.currentUrl}` : "",
    `Respond with ONLY the JSON object — no fences, no prose.`,
  ]
    .filter(Boolean)
    .join("\n");

  const resp = await fetch(`${getOllamaApiUrl()}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      stream: false,
      format: "json",
      messages: [
        { role: "system", content: BUILDER_SYSTEM_PROMPT },
        { role: "user", content: userMsg },
      ],
    }),
  });

  if (!resp.ok) {
    throw new Error(
      `Ollama returned ${resp.status} ${resp.statusText} while building plugin`,
    );
  }

  const data = (await resp.json()) as { message?: { content?: string } };
  const content = data.message?.content?.trim();
  if (!content) {
    throw new Error("AI builder returned empty response");
  }

  let parsed: Partial<BrowserPlugin>;
  try {
    parsed = JSON.parse(stripJsonFences(content));
  } catch (err) {
    logger.error("AI builder JSON parse failed. Raw content:", content);
    throw new Error(
      `AI builder did not return valid JSON: ${(err as Error).message}`,
    );
  }

  const type = (parsed.type ?? "page-action") as BrowserPluginType;
  if (!["page-action", "widget", "command"].includes(type)) {
    throw new Error(`AI builder produced unknown plugin type "${type}"`);
  }
  if (typeof parsed.code !== "string" || !parsed.code.trim()) {
    throw new Error("AI builder did not return runnable code");
  }
  if (typeof parsed.name !== "string" || !parsed.name.trim()) {
    throw new Error("AI builder did not return a name");
  }

  const now = Date.now();
  return {
    id: makeId(),
    name: parsed.name.trim().slice(0, 60),
    description: (parsed.description ?? req.description).trim().slice(0, 240),
    type,
    code: parsed.code,
    promptTemplate: parsed.promptTemplate,
    icon: parsed.icon,
    enabled: true,
    builtin: false,
    author: "ai",
    createdAt: now,
    updatedAt: now,
  };
}

// ── Registration ─────────────────────────────────────────────────────────

export function registerBrowserPluginHandlers(): void {
  logger.info("Registering Browser Plugin IPC handlers");

  handle("browser-plugins:list", async (): Promise<BrowserPlugin[]> => {
    const store = await readStore();
    return store.plugins.sort((a, b) => {
      if (a.builtin !== b.builtin) return a.builtin ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  });

  handle(
    "browser-plugins:save",
    async (
      _evt,
      params: CreateBrowserPluginRequest | UpdateBrowserPluginRequest,
    ): Promise<BrowserPlugin> => {
      const store = await readStore();
      const now = Date.now();

      if ("id" in params && "patch" in params) {
        const idx = store.plugins.findIndex((p) => p.id === params.id);
        if (idx === -1) throw new Error(`Plugin not found: ${params.id}`);
        const current = store.plugins[idx];
        if (current.builtin && params.patch.code !== undefined) {
          throw new Error("Cannot modify the code of a built-in plugin");
        }
        const updated: BrowserPlugin = {
          ...current,
          ...params.patch,
          id: current.id,
          createdAt: current.createdAt,
          updatedAt: now,
        };
        store.plugins[idx] = updated;
        await writeStore(store);
        return updated;
      }

      const req = params as CreateBrowserPluginRequest;
      if (!req.name?.trim()) throw new Error("Plugin name is required");
      if (!req.code?.trim()) throw new Error("Plugin code is required");
      if (!["page-action", "widget", "command"].includes(req.type)) {
        throw new Error(`Unknown plugin type: ${req.type}`);
      }
      const plugin: BrowserPlugin = {
        id: makeId(),
        name: req.name.trim().slice(0, 60),
        description: (req.description ?? "").trim().slice(0, 240),
        type: req.type,
        code: req.code,
        promptTemplate: req.promptTemplate,
        icon: req.icon,
        enabled: req.enabled ?? true,
        builtin: false,
        author: req.author ?? "user",
        createdAt: now,
        updatedAt: now,
      };
      store.plugins.push(plugin);
      await writeStore(store);
      return plugin;
    },
  );

  handle(
    "browser-plugins:delete",
    async (_evt, params: { id: string }): Promise<{ ok: true }> => {
      const store = await readStore();
      const idx = store.plugins.findIndex((p) => p.id === params.id);
      if (idx === -1) throw new Error(`Plugin not found: ${params.id}`);
      if (store.plugins[idx].builtin) {
        throw new Error("Built-in plugins cannot be deleted (disable instead)");
      }
      store.plugins.splice(idx, 1);
      await writeStore(store);
      return { ok: true };
    },
  );

  handle(
    "browser-plugins:toggle",
    async (
      _evt,
      params: { id: string; enabled: boolean },
    ): Promise<BrowserPlugin> => {
      const store = await readStore();
      const idx = store.plugins.findIndex((p) => p.id === params.id);
      if (idx === -1) throw new Error(`Plugin not found: ${params.id}`);
      store.plugins[idx].enabled = !!params.enabled;
      store.plugins[idx].updatedAt = Date.now();
      await writeStore(store);
      return store.plugins[idx];
    },
  );

  handle(
    "browser-plugins:build",
    async (_evt, params: BuildBrowserPluginRequest): Promise<BrowserPlugin> => {
      if (!params?.description?.trim()) {
        throw new Error("A description is required to build a plugin");
      }
      return buildPluginWithOllama(params);
    },
  );
}
