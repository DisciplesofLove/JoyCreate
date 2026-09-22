/**
 * Subscription-backed agent CLIs.
 *
 * Every AI provider in JoyCreate has so far required an API key, which is a
 * metered, pay-per-token credential. That is not how most people actually buy
 * AI: they pay a flat monthly fee for Claude Pro/Max, ChatGPT Plus/Pro, Google
 * AI Pro, or GitHub Copilot. Claude Code and the VS Code extensions use that
 * subscription directly, and until now JoyCreate could not.
 *
 * The mechanism those editors use is not a secret API — it is the vendor's own
 * command-line agent, which performs an OAuth login and then holds and refreshes
 * the token itself. So JoyCreate does the same thing an editor does: find the
 * CLI, spawn it headless, and read its output.
 *
 * Two rules follow from that, and they are the reason this module exists at all:
 *
 *   1. **We never read the credential file.** `~/.claude/.credentials.json`,
 *      `~/.codex/auth.json` and friends belong to the CLI. We look at whether a
 *      path exists to give a useful hint in the UI, never at what is inside it.
 *      Lifting a token out of one of those files and replaying it against a
 *      private endpoint is how integrations get people's accounts banned.
 *   2. **Argv is data, not code.** Each CLI's flags change between versions, and
 *      none of them is installed on every machine. Keeping the invocation in one
 *      table means a flag change is a one-line edit here, and means the "Test"
 *      button in the UI reports the CLI's own stderr verbatim instead of a
 *      guess we invented.
 *
 * This is a leaf module: no imports, no Electron, no filesystem. It can be
 * imported from the renderer for labels and from the main process for spawning.
 */

export type SubscriptionCliId = "claude-cli" | "codex-cli" | "gemini-cli" | "copilot-cli";

/** One parsed piece of a CLI's stdout. */
export interface CliEvent {
  /** Text to append to the assistant's reply. */
  text?: string;
  /** The run finished successfully; `text` here is the *final* answer. */
  final?: string;
  /** The CLI reported a failure. */
  error?: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

export interface SubscriptionCliDefinition {
  id: SubscriptionCliId;
  /** Provider id used in settings + the model picker. Same as `id`. */
  label: string;
  /** The subscription this unlocks, in the words the vendor sells it under. */
  subscription: string;
  vendor: string;
  /** Executable names to look for, in preference order. */
  binaries: string[];
  /**
   * Extra directories to search beyond `PATH`, as `${envVarName}${suffix}`.
   * npm-global and the vendors' own installers routinely land outside PATH for
   * GUI apps, which inherit a login shell's environment on neither Windows nor
   * macOS.
   */
  searchPaths: { env: string; suffix: string }[];
  /** Argv that prints a version and exits non-interactively. */
  versionArgs: string[];
  /**
   * Paths, relative to the home directory, that the CLI creates at login. The
   * first that exists wins. Checked for existence and size only — never opened.
   *
   * More than one because these differ by platform: Copilot writes under
   * `.config/` on POSIX and `AppData` on Windows, and checking only the POSIX
   * path made a signed-in Windows user look signed out.
   */
  credentialHints: string[];
  /** What to tell the user to run when the CLI is present but not logged in. */
  loginCommand: string;
  installCommand: string;
  docsUrl: string;
  /** Models worth offering. `id` is passed through to the CLI's model flag. */
  models: { id: string; label: string; description: string }[];
  /** Build the argv for a one-shot headless run. */
  buildArgs: (prompt: string, model: string | undefined) => string[];
  /**
   * Turn one line of stdout into an event. Returning null means "nothing to
   * show" — a progress line, a banner, an event type we do not care about.
   *
   * Lines that are not JSON are handed back as plain text, so a CLI that simply
   * prints its answer works through exactly the same path as one that emits
   * structured events.
   */
  parseLine: (line: string) => CliEvent | null;
}

// ─── parsers ────────────────────────────────────────────────────────────────

/** Pull the text out of an Anthropic-shaped content block array. */
function anthropicContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      const b = block as Record<string, unknown>;
      return b?.type === "text" && typeof b.text === "string" ? b.text : "";
    })
    .join("");
}

function tryJson(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

const claudeParse = (line: string): CliEvent | null => {
  const ev = tryJson(line);
  // `--output-format stream-json` emits NDJSON, but a banner or a warning can
  // still arrive as bare text. Showing it beats swallowing it.
  if (!ev) return line.trim() ? { text: line } : null;

  switch (ev.type) {
    case "assistant": {
      const msg = ev.message as Record<string, unknown> | undefined;
      const text = anthropicContentText(msg?.content);
      return text ? { text } : null;
    }
    case "result": {
      const usage = ev.usage as Record<string, unknown> | undefined;
      if (ev.subtype && ev.subtype !== "success") {
        return {
          error:
            typeof ev.result === "string"
              ? ev.result
              : `Claude Code ended with "${String(ev.subtype)}"`,
        };
      }
      return {
        final: typeof ev.result === "string" ? ev.result : undefined,
        inputTokens: numberOr(usage?.input_tokens),
        outputTokens: numberOr(usage?.output_tokens),
        costUsd: numberOr(ev.total_cost_usd),
      };
    }
    default:
      // system/init, tool_use, tool_result — useful to a coding agent, noise here.
      return null;
  }
};

const codexParse = (line: string): CliEvent | null => {
  const ev = tryJson(line);
  if (!ev) return line.trim() ? { text: line } : null;

  // Codex has shipped more than one event envelope. Accept both the flat shape
  // and the `{ msg: { type, ... } }` one rather than betting on a version.
  const msg = (ev.msg as Record<string, unknown> | undefined) ?? ev;
  const type = String(msg.type ?? "");

  if (type === "agent_message" || type === "assistant_message") {
    const text = msg.message ?? msg.text ?? msg.content;
    return typeof text === "string" && text ? { text } : null;
  }
  if (type === "agent_message_delta" || type === "assistant_message_delta") {
    const delta = msg.delta ?? msg.text;
    return typeof delta === "string" && delta ? { text: delta } : null;
  }
  if (type === "error" || type === "stream_error") {
    return { error: String(msg.message ?? msg.error ?? "Codex reported an error") };
  }
  if (type === "token_count" || type === "usage") {
    const info = (msg.info as Record<string, unknown> | undefined) ?? msg;
    return {
      inputTokens: numberOr(info.input_tokens ?? info.prompt_tokens),
      outputTokens: numberOr(info.output_tokens ?? info.completion_tokens),
    };
  }
  return null;
};

/** Gemini and Copilot print their answer as plain prose. */
const plainTextParse = (line: string): CliEvent | null =>
  line.trim() ? { text: line } : null;

function numberOr(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

// ─── the registry ───────────────────────────────────────────────────────────

export const SUBSCRIPTION_CLIS: SubscriptionCliDefinition[] = [
  {
    id: "claude-cli",
    label: "Claude (subscription)",
    subscription: "Claude Pro or Max",
    vendor: "Anthropic",
    binaries: ["claude", "claude.exe", "claude.cmd"],
    searchPaths: [
      { env: "APPDATA", suffix: "/npm" },
      { env: "USERPROFILE", suffix: "/.claude/local" },
      { env: "USERPROFILE", suffix: "/.local/bin" },
      { env: "USERPROFILE", suffix: "/.bun/bin" },
      { env: "LOCALAPPDATA", suffix: "/Programs/claude" },
      { env: "HOME", suffix: "/.local/bin" },
      { env: "HOME", suffix: "/.claude/local" },
      { env: "HOME", suffix: "/.bun/bin" },
    ],
    versionArgs: ["--version"],
    credentialHints: [".claude/.credentials.json", ".config/claude/.credentials.json"],
    loginCommand: "claude login",
    installCommand: "npm install -g @anthropic-ai/claude-code",
    docsUrl: "https://docs.claude.com/en/docs/claude-code/overview",
    models: [
      {
        id: "claude-opus-5",
        label: "Claude Opus 5",
        description: "Anthropic's recommended default for most work.",
      },
      {
        id: "claude-fable-5-1",
        label: "Claude Fable 5.1",
        description: "Deepest reasoning and long-horizon work. Heaviest on plan limits.",
      },
      {
        id: "claude-sonnet-5",
        label: "Claude Sonnet 5",
        description: "Fast and strong — lighter on your quota.",
      },
      {
        id: "claude-haiku-4-5",
        label: "Claude Haiku 4.5",
        description: "Fastest and cheapest on your quota.",
      },
    ],
    buildArgs: (prompt, model) => {
      const args = [
        "-p",
        prompt,
        "--output-format",
        "stream-json",
        // stream-json refuses to run without --verbose.
        "--verbose",
        // One question, one answer. Without this the CLI may start using tools
        // and editing files, which is emphatically not what a chat box asked for.
        "--max-turns",
        "1",
      ];
      if (model) args.push("--model", model);
      return args;
    },
    parseLine: claudeParse,
  },
  {
    id: "codex-cli",
    label: "ChatGPT (subscription)",
    subscription: "ChatGPT Plus, Pro, Business or Enterprise",
    vendor: "OpenAI",
    binaries: ["codex", "codex.exe", "codex.cmd"],
    searchPaths: [
      { env: "APPDATA", suffix: "/npm" },
      { env: "USERPROFILE", suffix: "/.codex/bin" },
      { env: "USERPROFILE", suffix: "/.local/bin" },
      { env: "USERPROFILE", suffix: "/.bun/bin" },
      { env: "USERPROFILE", suffix: "/.cargo/bin" },
      { env: "LOCALAPPDATA", suffix: "/Programs/codex" },
      { env: "HOME", suffix: "/.local/bin" },
      { env: "HOME", suffix: "/.codex/bin" },
      { env: "HOME", suffix: "/.cargo/bin" },
    ],
    versionArgs: ["--version"],
    credentialHints: [".codex/auth.json"],
    loginCommand: "codex login",
    installCommand: "npm install -g @openai/codex",
    docsUrl: "https://developers.openai.com/codex/cli",
    models: [
      // The GPT-5.x Codex models were shut down on 2026-07-23; OpenAI names
      // gpt-5.6-sol and gpt-5.6-terra as their replacements.
      {
        id: "gpt-5.6-sol",
        label: "GPT-5.6 Sol",
        description: "OpenAI's flagship for complex and coding work.",
      },
      {
        id: "gpt-6-astra",
        label: "GPT-6 Astra",
        description: "Most capable; heaviest on plan limits, where your plan includes it.",
      },
      {
        id: "gpt-5.6-terra",
        label: "GPT-5.6 Terra",
        description: "Balanced cost and capability.",
      },
      {
        id: "gpt-5.6-luna",
        label: "GPT-5.6 Luna",
        description: "Lightest on your quota.",
      },
    ],
    buildArgs: (prompt, model) => {
      const args = ["exec", "--json", "--skip-git-repo-check"];
      if (model) args.push("--model", model);
      // The prompt goes last and positionally, so a prompt beginning with "-"
      // is never mistaken for a flag.
      args.push(prompt);
      return args;
    },
    parseLine: codexParse,
  },
  {
    id: "gemini-cli",
    label: "Gemini (subscription)",
    subscription: "Google AI Pro or Ultra, or the free Google account tier",
    vendor: "Google",
    binaries: ["gemini", "gemini.exe", "gemini.cmd"],
    searchPaths: [
      { env: "APPDATA", suffix: "/npm" },
      { env: "USERPROFILE", suffix: "/.local/bin" },
      { env: "USERPROFILE", suffix: "/.bun/bin" },
      { env: "HOME", suffix: "/.local/bin" },
      { env: "HOME", suffix: "/.bun/bin" },
    ],
    versionArgs: ["--version"],
    credentialHints: [".gemini/oauth_creds.json", ".config/gcloud/application_default_credentials.json"],
    loginCommand: "gemini  (then choose “Login with Google”)",
    installCommand: "npm install -g @google/gemini-cli",
    docsUrl: "https://github.com/google-gemini/gemini-cli",
    models: [
      {
        id: "gemini-3.8-flash",
        label: "Gemini 3.8 Flash",
        description: "Google's newest Flash — strong for coding and agents.",
      },
      {
        id: "gemini-3.1-pro-preview",
        label: "Gemini 3.1 Pro (Preview)",
        description: "Deepest reasoning.",
      },
      {
        id: "gemini-3.5-flash-lite",
        label: "Gemini 3.5 Flash-Lite",
        description: "Fastest and lightest on your quota.",
      },
    ],
    buildArgs: (prompt, model) => {
      const args = ["-p", prompt];
      if (model) args.push("-m", model);
      return args;
    },
    parseLine: plainTextParse,
  },
  {
    id: "copilot-cli",
    label: "GitHub Copilot (subscription)",
    subscription: "Copilot Free, Pro, Pro+ or Business",
    vendor: "GitHub",
    binaries: ["copilot", "copilot.exe", "copilot.cmd"],
    searchPaths: [
      { env: "APPDATA", suffix: "/npm" },
      {
        env: "APPDATA",
        suffix: "/Code/User/globalStorage/github.copilot-chat/copilotCli",
      },
      { env: "USERPROFILE", suffix: "/.local/bin" },
      { env: "HOME", suffix: "/.local/bin" },
      {
        env: "HOME",
        suffix:
          "/Library/Application Support/Code/User/globalStorage/github.copilot-chat/copilotCli",
      },
    ],
    versionArgs: ["--version"],
    credentialHints: [
      ".config/github-copilot/apps.json",
      ".config/github-copilot/hosts.json",
      "AppData/Local/github-copilot/apps.json",
      "AppData/Roaming/GitHub Copilot/hosts.json",
    ],
    loginCommand: "copilot  (then /login)",
    installCommand: "npm install -g @github/copilot",
    docsUrl: "https://docs.github.com/copilot/concepts/agents/about-copilot-cli",
    models: [
      // GitHub publishes Copilot's models by display name, not the identifier
      // its CLI's --model flag takes. A guessed identifier fails the run, so
      // this defers to whatever model the user's Copilot plan selects.
      {
        id: "default",
        label: "Copilot's default model",
        description: "Whichever model your Copilot plan selects.",
      },
    ],
    buildArgs: (prompt, model) => {
      const args = ["-p", prompt, "--allow-all-tools"];
      if (model && model !== "default") args.push("--model", model);
      return args;
    },
    parseLine: plainTextParse,
  },
];

const byId = new Map(SUBSCRIPTION_CLIS.map((c) => [c.id, c]));

export function getSubscriptionCli(
  id: string,
): SubscriptionCliDefinition | undefined {
  return byId.get(id as SubscriptionCliId);
}

export function isSubscriptionCliProvider(providerId: string): boolean {
  return byId.has(providerId as SubscriptionCliId);
}

export const SUBSCRIPTION_CLI_IDS: SubscriptionCliId[] = SUBSCRIPTION_CLIS.map(
  (c) => c.id,
);
