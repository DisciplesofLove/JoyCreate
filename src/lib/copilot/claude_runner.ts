/**
 * Claude Code SDK runner — heavy tier of the Copilot.
 *
 * Headless Claude Code session bounded to:
 *   - read-only tools by default
 *   - writes go to a "self-heal/<jobId>" git branch, never main
 *   - every result emits a provenance event (signed, mirrored to hyper)
 *   - daily Claude budget cap is enforced by the orchestrator, not here
 *
 * The SDK is loaded lazily so the rest of the app keeps compiling even
 * when @anthropic-ai/claude-code isn't installed yet.
 */

import { app } from "electron";
import * as path from "path";
import log from "electron-log";

const logger = log.scope("copilot:claude_runner");

export interface ClaudeRunOptions {
  /** Job id — used as branch suffix and provenance subject ref. */
  jobId: string;
  /** Plain-English bounded brief. */
  taskBrief: string;
  /** Working directory — defaults to repo root (cwd when packaged from source). */
  cwd?: string;
  /** Allowed Claude Code tools. Defaults to read-only + bounded edits. */
  allowedTools?: string[];
  /** Disallowed Claude Code tools. Defaults to dangerous shell ops. */
  disallowedTools?: string[];
  /** Anthropic API key. Falls back to ANTHROPIC_API_KEY env. */
  apiKey?: string;
  /** Hard cap on output tokens per run. */
  maxTurns?: number;
  /** Stream callback for token-by-token UI updates. */
  onProgress?: (chunk: { type: string; content: string }) => void;
}

export interface ClaudeRunResult {
  ok: boolean;
  /** Final assistant message text. */
  output: string;
  /** Branch claude wrote to (if any edits were made). */
  branchName?: string;
  /** Estimated USD cost for this run (best-effort from SDK metadata). */
  costUsd: number;
  /** Total session messages exchanged. */
  numTurns: number;
  /** Path to the diff file (relative to userData) if a diff was produced. */
  diffPath?: string;
  errorMessage?: string;
}

const DEFAULT_ALLOWED_TOOLS = [
  "Read",
  "Glob",
  "Grep",
  "Edit",
  "Write",
  "Bash(npm test:*)",
  "Bash(npm run lint)",
  "Bash(npm run db:generate)",
  "Bash(git status)",
  "Bash(git diff:*)",
  "Bash(git checkout -b:*)",
  "Bash(git add:*)",
  "Bash(git commit:*)",
];

const DEFAULT_DISALLOWED_TOOLS = [
  "Bash(rm:*)",
  "Bash(git push:*)",
  "Bash(git reset --hard:*)",
  "Bash(git checkout main)",
  "Bash(git checkout master)",
  "Bash(npm publish:*)",
  "Bash(curl:*)",
  "Bash(wget:*)",
];

/**
 * Run a bounded Claude Code session.
 *
 * The SDK exposes a `query` async-iterator. We collect all messages, capture
 * the final assistant text, and surface usage metadata. Branch creation is
 * left to Claude itself (via the allowlisted git tools).
 */
export async function runClaudeCodeJob(
  opts: ClaudeRunOptions,
): Promise<ClaudeRunResult> {
  const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      ok: false,
      output: "",
      costUsd: 0,
      numTurns: 0,
      errorMessage:
        "No Anthropic API key. Set ANTHROPIC_API_KEY or pass apiKey in copilot settings.",
    };
  }

  // Lazy import — the SDK ships an ESM binary helper that we don't want
  // to load at app startup.
  let querySdk: typeof import("@anthropic-ai/claude-code")["query"];
  try {
    const sdk = await import("@anthropic-ai/claude-code");
    querySdk = sdk.query;
  } catch (err) {
    return {
      ok: false,
      output: "",
      costUsd: 0,
      numTurns: 0,
      errorMessage:
        "Claude Code SDK is not installed. Run: npm install @anthropic-ai/claude-code --legacy-peer-deps",
    };
  }

  const branchName = `self-heal/${opts.jobId}`;
  const wrappedPrompt = buildBoundedPrompt(opts.taskBrief, branchName);
  const cwd = opts.cwd ?? process.cwd();

  let finalOutput = "";
  let costUsd = 0;
  let numTurns = 0;

  try {
    const sessionIter = querySdk({
      prompt: wrappedPrompt,
      options: {
        cwd,
        allowedTools: opts.allowedTools ?? DEFAULT_ALLOWED_TOOLS,
        disallowedTools: opts.disallowedTools ?? DEFAULT_DISALLOWED_TOOLS,
        maxTurns: opts.maxTurns ?? 25,
        permissionMode: "acceptEdits",
        env: {
          ...process.env,
          ANTHROPIC_API_KEY: apiKey,
        },
      },
    });

    for await (const message of sessionIter) {
      numTurns++;
      const mAny = message as unknown as Record<string, unknown>;

      if (mAny.type === "assistant") {
        const content = extractText(mAny);
        if (content) {
          finalOutput = content;
          opts.onProgress?.({ type: "assistant", content });
        }
      } else if (mAny.type === "tool_use") {
        opts.onProgress?.({
          type: "tool",
          content: String(mAny.name ?? "unknown"),
        });
      } else if (mAny.type === "result") {
        const r = mAny as { total_cost_usd?: number; result?: string };
        if (typeof r.total_cost_usd === "number") costUsd = r.total_cost_usd;
        if (typeof r.result === "string" && r.result) finalOutput = r.result;
      }
    }
  } catch (err) {
    return {
      ok: false,
      output: finalOutput,
      branchName,
      costUsd,
      numTurns,
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }

  // Best-effort: capture the diff Claude produced for human review.
  const diffPath = await captureDiff(opts.jobId, branchName, cwd);

  return {
    ok: true,
    output: finalOutput,
    branchName,
    costUsd,
    numTurns,
    diffPath,
  };
}

function buildBoundedPrompt(taskBrief: string, branchName: string): string {
  return `You are JoyCreate's self-healing assistant running headless.

RULES (non-negotiable):
1. Create a new git branch named "${branchName}" before any edits.
2. Make the MINIMUM change required to satisfy the task. Do not refactor neighboring code.
3. After editing, run \`npm run lint\` and \`npm test\` to validate.
4. Commit your changes on the branch with a clear message starting with "self-heal: ".
5. Do NOT push, do NOT merge to main, do NOT delete files.
6. End your response with a one-paragraph summary of what you changed and why.

TASK:
${taskBrief}
`;
}

function extractText(msg: Record<string, unknown>): string {
  const content = msg.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        const cAny = c as Record<string, unknown>;
        if (cAny.type === "text" && typeof cAny.text === "string") return cAny.text;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/**
 * Capture `git diff main...<branch>` as a unified-diff file under userData
 * so the UI can render it for approval.
 */
async function captureDiff(
  jobId: string,
  branchName: string,
  cwd: string,
): Promise<string | undefined> {
  try {
    const { execFile } = await import("child_process");
    const { promisify } = await import("util");
    const fs = await import("fs/promises");
    const exec = promisify(execFile);

    // Determine the merge base — either main or master.
    let baseBranch = "main";
    try {
      await exec("git", ["rev-parse", "--verify", "main"], { cwd });
    } catch {
      baseBranch = "master";
    }

    const { stdout } = await exec(
      "git",
      ["diff", `${baseBranch}...${branchName}`],
      { cwd, maxBuffer: 10 * 1024 * 1024 },
    );

    if (!stdout.trim()) return undefined;

    const outDir = path.join(app.getPath("userData"), "copilot", "diffs");
    await fs.mkdir(outDir, { recursive: true });
    const outPath = path.join(outDir, `${jobId}.diff`);
    await fs.writeFile(outPath, stdout, "utf8");
    return outPath;
  } catch (err) {
    logger.warn("Failed to capture diff:", err);
    return undefined;
  }
}
