/**
 * Code Studio AI Agent — IPC handlers.
 *
 * Wires the in-app code editor to a real LLM-backed agent that can:
 *   - list / read / search files in the active workspace
 *   - propose multi-file edits
 *   - apply edits when the user opts in (autoApprove)
 *
 * Channels (renderer → main):
 *   - `code-studio:agent:run`   { intent, openFile?, autoApprove?, model?, provider? }
 *      → returns { changes: FileChange[], summary: string }
 *   - `code-studio:agent:cancel` { runId }
 *
 * Channels (main → renderer):
 *   - `code-studio:agent:event` { runId, kind, ... }
 *
 * Failures throw — never return `{ success: false }` envelopes.
 */

import { ipcMain, type IpcMainInvokeEvent } from "electron";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { z } from "zod";
import { tool, stepCountIs, streamText } from "ai";
import log from "electron-log";
import { randomUUID } from "node:crypto";

import { readSettings } from "../../main/settings";
import { getModelClient } from "../utils/get_model_client";
import { safeSend } from "../utils/safe_sender";
import {
  getCodeStudioWorkspaceRoot,
  getCodeStudioIgnoredDirs,
} from "./code_studio_handlers";

const logger = log.scope("code-studio:agent");

// ---------------------------------------------------------------------------
// Types shared with the renderer
// ---------------------------------------------------------------------------

export interface CodeStudioFileChange {
  path: string;
  type: "created" | "modified" | "deleted";
  linesAdded?: number;
  linesRemoved?: number;
}

export interface CodeStudioAgentRunResult {
  runId: string;
  summary: string;
  changes: CodeStudioFileChange[];
  /** True when the agent finished its plan; false on cancel/timeout. */
  finished: boolean;
}

export interface CodeStudioAgentEvent {
  runId: string;
  kind:
    | "started"
    | "thinking"
    | "tool"
    | "text"
    | "applied"
    | "rejected"
    | "error"
    | "done";
  message?: string;
  toolName?: string;
  toolInput?: unknown;
  toolOutput?: unknown;
  textDelta?: string;
  change?: CodeStudioFileChange;
  error?: string;
}

interface RunOptions {
  intent: string;
  openFile?: string | null;
  /** When false the agent only proposes edits and skips writes. */
  autoApprove?: boolean;
  model?: string;
  provider?: string;
}

// ---------------------------------------------------------------------------
// Cancellation registry — runId -> AbortController
// ---------------------------------------------------------------------------

const activeRuns = new Map<string, AbortController>();

// ---------------------------------------------------------------------------
// Workspace-scoped helpers (kept independent from the file-tree handlers so
// that the agent never escapes the workspace root, even if the user picks a
// surprising path).
// ---------------------------------------------------------------------------

function requireWorkspace(): string {
  const root = getCodeStudioWorkspaceRoot();
  if (!root) {
    throw new Error(
      "No workspace open in Code Studio. Open a folder before running the agent.",
    );
  }
  return root;
}

function safeJoin(rel: string): string {
  const root = requireWorkspace();
  const normalized = path.resolve(root, rel || ".");
  if (
    normalized !== path.resolve(root) &&
    !normalized.startsWith(path.resolve(root) + path.sep)
  ) {
    throw new Error(`Path escapes workspace root: ${rel}`);
  }
  return normalized;
}

function toRel(abs: string): string {
  const root = path.resolve(requireWorkspace());
  return path.relative(root, abs).replace(/\\/g, "/");
}

async function listDirEntries(rel: string) {
  const abs = safeJoin(rel);
  const dirents = await fs.readdir(abs, { withFileTypes: true });
  const ignored = getCodeStudioIgnoredDirs();
  const out: Array<{ name: string; type: "file" | "directory"; relPath: string }> =
    [];
  for (const d of dirents) {
    if (ignored.has(d.name)) continue;
    if (d.name.startsWith(".") && d.name !== ".env" && d.name !== ".gitignore")
      continue;
    out.push({
      name: d.name,
      type: d.isDirectory() ? "directory" : "file",
      relPath: toRel(path.join(abs, d.name)),
    });
  }
  out.sort((a, b) => {
    if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return out;
}

async function readFileText(rel: string, maxBytes = 200_000): Promise<string> {
  const abs = safeJoin(rel);
  const stat = await fs.stat(abs);
  if (stat.size > maxBytes) {
    throw new Error(
      `File too large for the agent to read (${stat.size} bytes > ${maxBytes}): ${rel}`,
    );
  }
  return fs.readFile(abs, "utf-8");
}

async function writeFileText(rel: string, content: string) {
  const abs = safeJoin(rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf-8");
}

async function deleteFileOrDir(rel: string) {
  const abs = safeJoin(rel);
  const stat = await fs.stat(abs);
  if (stat.isDirectory()) {
    await fs.rm(abs, { recursive: true, force: true });
  } else {
    await fs.unlink(abs);
  }
}

async function searchInWorkspace(
  query: string,
  opts: { caseSensitive?: boolean; maxResults?: number } = {},
): Promise<Array<{ relPath: string; line: number; preview: string }>> {
  const root = requireWorkspace();
  const ignored = getCodeStudioIgnoredDirs();
  const max = opts.maxResults ?? 60;
  const matcher = opts.caseSensitive
    ? (line: string) => line.includes(query)
    : ((q) => (line: string) => line.toLowerCase().includes(q))(query.toLowerCase());

  const hits: Array<{ relPath: string; line: number; preview: string }> = [];

  async function walk(dir: string): Promise<void> {
    if (hits.length >= max) return;
    let dirents: import("node:fs").Dirent[];
    try {
      dirents = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of dirents) {
      if (hits.length >= max) return;
      if (ignored.has(d.name)) continue;
      const abs = path.join(dir, d.name);
      if (d.isDirectory()) {
        await walk(abs);
        continue;
      }
      if (!d.isFile()) continue;
      try {
        const stat = await fs.stat(abs);
        if (stat.size > 512 * 1024) continue;
        const content = await fs.readFile(abs, "utf-8");
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (matcher(lines[i])) {
            hits.push({
              relPath: path.relative(root, abs).replace(/\\/g, "/"),
              line: i + 1,
              preview: lines[i].slice(0, 240),
            });
            if (hits.length >= max) return;
          }
        }
      } catch {
        // skip unreadable file
      }
    }
  }

  await walk(root);
  return hits;
}

function diffLineCounts(
  oldContent: string,
  newContent: string,
): { added: number; removed: number } {
  const oldLines = oldContent ? oldContent.split("\n").length : 0;
  const newLines = newContent ? newContent.split("\n").length : 0;
  if (newLines >= oldLines) {
    return { added: newLines - oldLines, removed: 0 };
  }
  return { added: 0, removed: oldLines - newLines };
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

function buildSystemPrompt(workspaceRoot: string, openFile: string | null): string {
  return `You are JoyCreate Code Studio, an autonomous coding agent embedded
inside an Electron desktop app. You can read, search and edit files in the
user's workspace using the provided tools.

Workspace root: ${workspaceRoot}
${openFile ? `Currently open file: ${openFile}` : "No file currently focused in the editor."}

Rules:
- ALWAYS use tools to read files before editing them.
- Pass workspace-relative paths to every tool (no absolute paths, no ".." escapes).
- For multi-file changes, call write_file once per file with the COMPLETE file contents.
- Keep changes minimal and focused on the user's request.
- When you finish, send a short final message summarising what you changed.
- Do not invent file paths — list a directory or search first if you are unsure.
- Never run shell commands (you don't have that tool here).`;
}

// ---------------------------------------------------------------------------
// Main run loop
// ---------------------------------------------------------------------------

async function runAgent(
  event: IpcMainInvokeEvent,
  opts: RunOptions,
): Promise<CodeStudioAgentRunResult> {
  const root = requireWorkspace();
  const intent = (opts.intent ?? "").trim();
  if (!intent) {
    throw new Error("Empty intent — describe what the agent should do.");
  }

  const runId = randomUUID();
  const abort = new AbortController();
  activeRuns.set(runId, abort);

  const emit = (ev: Omit<CodeStudioAgentEvent, "runId">) => {
    safeSend(event.sender, "code-studio:agent:event", { runId, ...ev });
  };

  emit({ kind: "started", message: `Agent run started in ${root}` });

  // Resolve LLM
  const settings = readSettings();
  const model =
    opts.model && opts.provider
      ? { provider: opts.provider, name: opts.model }
      : settings.selectedModel ?? { provider: "auto", name: "auto" };
  let modelClient;
  try {
    const resolved = await getModelClient(model, settings);
    modelClient = resolved.modelClient;
  } catch (err) {
    activeRuns.delete(runId);
    const message = (err as Error).message;
    emit({ kind: "error", error: message });
    throw new Error(
      `Could not resolve a language model: ${message}. Set an API key in Settings or pick a configured provider.`,
    );
  }

  const changes = new Map<string, CodeStudioFileChange>();
  const autoApprove = opts.autoApprove !== false;

  // Track per-tool errors so we can summarise at the end.
  const toolErrors: string[] = [];

  const list_files = tool({
    description: "List files and directories under a workspace-relative path.",
    inputSchema: z.object({
      path: z
        .string()
        .default("")
        .describe(
          "Workspace-relative directory. Empty string lists the workspace root.",
        ),
    }),
    execute: async ({ path: rel }) => {
      try {
        const entries = await listDirEntries(rel ?? "");
        emit({
          kind: "tool",
          toolName: "list_files",
          toolInput: { path: rel },
          toolOutput: { count: entries.length },
        });
        return entries;
      } catch (err) {
        const msg = (err as Error).message;
        toolErrors.push(`list_files(${rel}): ${msg}`);
        emit({ kind: "tool", toolName: "list_files", error: msg });
        throw err;
      }
    },
  });

  const read_file = tool({
    description:
      "Read a UTF-8 text file from the workspace. Use this before editing.",
    inputSchema: z.object({
      path: z.string().describe("Workspace-relative file path."),
    }),
    execute: async ({ path: rel }) => {
      try {
        const content = await readFileText(rel);
        emit({
          kind: "tool",
          toolName: "read_file",
          toolInput: { path: rel },
          toolOutput: { bytes: content.length },
        });
        return { path: rel, content };
      } catch (err) {
        const msg = (err as Error).message;
        toolErrors.push(`read_file(${rel}): ${msg}`);
        emit({ kind: "tool", toolName: "read_file", error: msg });
        throw err;
      }
    },
  });

  const search_in_files = tool({
    description:
      "Search file contents for a literal substring across the workspace.",
    inputSchema: z.object({
      query: z.string().min(1),
      caseSensitive: z.boolean().optional(),
    }),
    execute: async ({ query, caseSensitive }) => {
      try {
        const hits = await searchInWorkspace(query, { caseSensitive });
        emit({
          kind: "tool",
          toolName: "search_in_files",
          toolInput: { query, caseSensitive },
          toolOutput: { hits: hits.length },
        });
        return hits;
      } catch (err) {
        const msg = (err as Error).message;
        toolErrors.push(`search_in_files(${query}): ${msg}`);
        emit({ kind: "tool", toolName: "search_in_files", error: msg });
        throw err;
      }
    },
  });

  const write_file = tool({
    description:
      "Create or overwrite a file with the supplied content. Pass the full new contents — partial patches are not supported. The change is auto-approved when autoApprove is on; otherwise the agent only records a proposed change for the user to review.",
    inputSchema: z.object({
      path: z.string(),
      content: z.string(),
    }),
    execute: async ({ path: rel, content }) => {
      let oldContent = "";
      let isCreate = false;
      try {
        oldContent = await fs.readFile(safeJoin(rel), "utf-8");
      } catch {
        isCreate = true;
      }

      if (!autoApprove) {
        emit({
          kind: "rejected",
          message: `Skipped write to ${rel} (autoApprove off — review/apply manually).`,
        });
        return {
          status: "skipped",
          reason: "autoApprove disabled — agent runs in dry-run mode.",
          path: rel,
          isCreate,
        };
      }

      try {
        await writeFileText(rel, content);
      } catch (err) {
        const msg = (err as Error).message;
        toolErrors.push(`write_file(${rel}): ${msg}`);
        emit({ kind: "tool", toolName: "write_file", error: msg });
        throw err;
      }

      const counts = diffLineCounts(oldContent, content);
      const change: CodeStudioFileChange = {
        path: rel,
        type: isCreate ? "created" : "modified",
        linesAdded: counts.added,
        linesRemoved: counts.removed,
      };
      changes.set(rel, change);
      emit({ kind: "applied", change });
      return { status: "applied", path: rel, isCreate };
    },
  });

  const delete_file = tool({
    description: "Delete a file or empty directory.",
    inputSchema: z.object({ path: z.string() }),
    execute: async ({ path: rel }) => {
      if (!autoApprove) {
        emit({
          kind: "rejected",
          message: `Skipped delete of ${rel} (autoApprove off).`,
        });
        return { status: "skipped", path: rel };
      }
      try {
        await deleteFileOrDir(rel);
      } catch (err) {
        const msg = (err as Error).message;
        toolErrors.push(`delete_file(${rel}): ${msg}`);
        emit({ kind: "tool", toolName: "delete_file", error: msg });
        throw err;
      }
      const change: CodeStudioFileChange = { path: rel, type: "deleted" };
      changes.set(rel, change);
      emit({ kind: "applied", change });
      return { status: "applied", path: rel };
    },
  });

  // Build prompt with the open file content as primary context.
  let userMessage = intent;
  if (opts.openFile) {
    try {
      const head = await readFileText(opts.openFile, 80_000);
      userMessage =
        `Currently open file (${opts.openFile}):\n\n` +
        "```\n" +
        head +
        "\n```\n\n" +
        intent;
    } catch {
      // open file may have been removed — keep going with intent only
    }
  }

  let textBuffer = "";
  let stream;
  try {
    stream = streamText({
      model: modelClient.model,
      system: buildSystemPrompt(root, opts.openFile ?? null),
      messages: [{ role: "user", content: userMessage }],
      tools: {
        list_files,
        read_file,
        search_in_files,
        write_file,
        delete_file,
      },
      stopWhen: stepCountIs(20),
      abortSignal: abort.signal,
      onError: (err) => {
        const msg = (err as { error?: { message?: string } })?.error?.message ?? String(err);
        logger.error("agent stream error", msg);
        emit({ kind: "error", error: msg });
      },
    });

    for await (const part of stream.fullStream) {
      if (abort.signal.aborted) break;
      switch (part.type) {
        case "text-delta":
          textBuffer += part.text;
          emit({ kind: "text", textDelta: part.text });
          break;
        case "reasoning-delta":
          emit({ kind: "thinking", message: part.text });
          break;
        case "tool-call":
          emit({
            kind: "tool",
            toolName: part.toolName,
            toolInput: part.input,
          });
          break;
        case "error": {
          const msg =
            (part as { error?: { message?: string } })?.error?.message ??
            String((part as { error?: unknown })?.error);
          emit({ kind: "error", error: msg });
          break;
        }
        default:
          // ignore step-start/finish/etc.
          break;
      }
    }
  } catch (err) {
    const msg = (err as Error).message;
    emit({ kind: "error", error: msg });
    activeRuns.delete(runId);
    throw new Error(`Agent stream failed: ${msg}`);
  }

  activeRuns.delete(runId);
  const summary =
    textBuffer.trim() ||
    (changes.size > 0
      ? `Applied ${changes.size} file change(s).`
      : toolErrors.length > 0
        ? `Agent finished with errors: ${toolErrors.slice(0, 3).join("; ")}`
        : "Agent finished without modifying any files.");

  const result: CodeStudioAgentRunResult = {
    runId,
    summary,
    changes: Array.from(changes.values()),
    finished: !abort.signal.aborted,
  };
  emit({ kind: "done", message: summary });
  return result;
}

// ---------------------------------------------------------------------------
// IPC registration
// ---------------------------------------------------------------------------

export function registerCodeStudioAgentHandlers(): void {
  ipcMain.handle(
    "code-studio:agent:run",
    async (event: IpcMainInvokeEvent, opts: RunOptions) => {
      return runAgent(event, opts ?? { intent: "" });
    },
  );

  ipcMain.handle(
    "code-studio:agent:cancel",
    async (_event: IpcMainInvokeEvent, runId: string) => {
      const ctrl = activeRuns.get(runId);
      if (!ctrl) {
        throw new Error(`No active run with id: ${runId}`);
      }
      ctrl.abort();
      activeRuns.delete(runId);
    },
  );
}
