/**
 * Running a prompt through a subscription CLI.
 *
 * One spawn per request, stdout read line by line and handed to the CLI's
 * parser from the registry. The parsers are deliberately forgiving: a line that
 * is not JSON becomes plain text, so a CLI that simply prints prose and one that
 * emits structured events both arrive here as the same `CliEvent` stream.
 *
 * The environment matters more than it looks. We strip `ANTHROPIC_API_KEY` and
 * `OPENAI_API_KEY` from the child's environment, because the whole point of this
 * path is to bill the user's *subscription*. If a key is exported in the parent
 * environment — and in this app one usually is — the CLI would quietly prefer it
 * and start charging per token against an account the user did not choose to use.
 */

import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import log from "electron-log";

import { requireCliBinary } from "./cli_detector";
import type { CliEvent, SubscriptionCliDefinition } from "./cli_registry";

const logger = log.scope("subscription-cli:run");

/** How long a single prompt may take before we give up on it. */
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export interface CliRunOptions {
  cliId: string;
  prompt: string;
  model?: string;
  /** Working directory. Defaults to the OS temp dir — see below. */
  cwd?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  onText?: (delta: string) => void;
}

export interface CliRunResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  /** Whatever the CLI wrote to stderr. Kept for the error message. */
  stderr: string;
}

/**
 * Keys that would divert the run onto metered billing. Deleting them is the
 * difference between "uses my Max plan" and "silently spends my API credit".
 */
const BILLING_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
];

function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of BILLING_ENV_KEYS) delete env[key];
  // Keep the CLIs from emitting ANSI colour into text we are about to show.
  env.NO_COLOR = "1";
  env.FORCE_COLOR = "0";
  return env;
}

/** stdin is "ignore", so stdout/stderr are piped and stdin is null. */
type CliChild = ChildProcessByStdio<null, Readable, Readable>;

function spawnCli(
  def: SubscriptionCliDefinition,
  binaryPath: string,
  args: string[],
  cwd: string,
): CliChild {
  // npm installs these as .cmd shims on Windows, which cmd.exe must interpret.
  const needsShell =
    process.platform === "win32" &&
    (binaryPath.endsWith(".cmd") || binaryPath.endsWith(".bat"));

  logger.info(`spawning ${def.id}: ${binaryPath} (${args.length} args)`);

  return spawn(binaryPath, args, {
    cwd,
    env: childEnv(),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    shell: needsShell,
  }) as CliChild;
}

/**
 * Run one prompt to completion.
 *
 * `onText` fires as output arrives so the chat pane can stream; the resolved
 * `text` is the complete answer either way.
 */
export async function runSubscriptionCli(
  opts: CliRunOptions,
): Promise<CliRunResult> {
  const { def, binaryPath } = await requireCliBinary(opts.cliId);
  const args = def.buildArgs(opts.prompt, opts.model);

  // These CLIs are coding agents: they read the working directory and some
  // refuse to run outside a git repo. A scratch directory keeps a chat request
  // from picking up whatever project happens to be open — and keeps it from
  // writing there.
  const cwd = opts.cwd ?? process.env.TEMP ?? process.env.TMPDIR ?? process.cwd();

  return await new Promise<CliRunResult>((resolve, reject) => {
    let child: CliChild;
    try {
      child = spawnCli(def, binaryPath, args, cwd);
    } catch (err) {
      return reject(
        new Error(
          `Could not start ${def.label}: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }

    let streamed = "";
    let finalText: string | null = null;
    let inputTokens = 0;
    let outputTokens = 0;
    let costUsd = 0;
    let reportedError: string | null = null;
    let stderr = "";
    let settled = false;

    const emit = (event: CliEvent) => {
      if (event.error) reportedError = event.error;
      if (event.inputTokens) inputTokens = event.inputTokens;
      if (event.outputTokens) outputTokens = event.outputTokens;
      if (event.costUsd) costUsd = event.costUsd;
      if (typeof event.final === "string") finalText = event.final;
      if (event.text) {
        const chunk = streamed ? `\n${event.text}` : event.text;
        streamed += chunk;
        opts.onText?.(chunk);
      }
    };

    // ── stdout, line by line ────────────────────────────────────────────────
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      // The last element is a partial line until the next chunk arrives.
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const event = def.parseLine(line);
        if (event) emit(event);
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      if (stderr.length > 16_000) stderr = stderr.slice(-16_000);
    });

    // ── lifecycle ───────────────────────────────────────────────────────────
    const timer = setTimeout(() => {
      child.kill();
      finish(
        new Error(
          `${def.label} did not finish within ${Math.round((opts.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000)}s.`,
        ),
      );
    }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    const onAbort = () => {
      child.kill();
      finish(new Error("Cancelled."));
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    function finish(error: Error | null, result?: CliRunResult) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(result!);
    }

    child.on("error", (err) => {
      finish(
        new Error(
          `${def.label} failed to run (${binaryPath}): ${err.message}`,
        ),
      );
    });

    child.on("close", (code) => {
      // Flush a trailing line with no newline after it.
      if (buffer.trim()) {
        const event = def.parseLine(buffer);
        if (event) emit(event);
      }

      if (reportedError) {
        return finish(new Error(`${def.label}: ${reportedError}`));
      }

      // A CLI can report its answer only in a terminal "result" event, having
      // streamed nothing — Claude Code with `--output-format stream-json` does
      // exactly that when the whole reply fits in one turn. The caller has been
      // shown nothing at that point, so the final text has to be pushed through
      // `onText` or it never reaches the chat pane.
      const text = finalText ?? streamed;
      if (finalText && !streamed) opts.onText?.(finalText);

      if (code !== 0) {
        // The CLI's own words are far more useful than ours — it is the thing
        // that knows whether the session expired or the plan hit its limit.
        const detail = (stderr.trim() || text.trim() || "no output").slice(-1200);
        return finish(
          new Error(
            `${def.label} exited with code ${code}.\n${detail}\n\n` +
              `If this says you are not authenticated, run:  ${def.loginCommand}`,
          ),
        );
      }

      if (!text.trim()) {
        return finish(
          new Error(
            `${def.label} produced no output. ` +
              `${stderr.trim() ? `It reported: ${stderr.trim().slice(-600)}` : `Try running "${def.loginCommand}" to confirm the session is still valid.`}`,
          ),
        );
      }

      finish(null, { text, inputTokens, outputTokens, costUsd, stderr });
    });
  });
}

/**
 * Prove the subscription actually works, end to end.
 *
 * Nothing else does: a binary on disk and a credential file both being present
 * says only that the user logged in at some point. This is what the Test button
 * calls, and it is the one honest answer to "is this working?".
 */
export async function testSubscriptionCli(
  cliId: string,
  model?: string,
): Promise<{ ok: true; reply: string; costUsd: number; durationMs: number }> {
  const started = Date.now();
  const result = await runSubscriptionCli({
    cliId,
    prompt:
      'Reply with exactly the word "ready" and nothing else. Do not use any tools.',
    model,
    timeoutMs: 120_000,
  });
  return {
    ok: true,
    reply: result.text.trim().slice(0, 400),
    costUsd: result.costUsd,
    durationMs: Date.now() - started,
  };
}
