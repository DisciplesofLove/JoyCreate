/**
 * Subscription CLIs — using a Claude Pro/Max, ChatGPT Plus, Google AI Pro or
 * Copilot plan instead of a metered API key.
 *
 * What these tests protect is mostly *parsing someone else's stdout*, which is
 * the part that breaks silently. A parser that drops the assistant's text does
 * not throw — the user just asks a question and watches an empty reply come
 * back, with nothing in the logs to say why.
 */

import { describe, expect, it } from "vitest";

import {
  SUBSCRIPTION_CLIS,
  getSubscriptionCli,
  isSubscriptionCliProvider,
} from "@/lib/subscription_cli/cli_registry";

const claude = getSubscriptionCli("claude-cli")!;
const codex = getSubscriptionCli("codex-cli")!;
const gemini = getSubscriptionCli("gemini-cli")!;

describe("the registry", () => {
  it("knows which providers are subscription-backed", () => {
    expect(isSubscriptionCliProvider("claude-cli")).toBe(true);
    expect(isSubscriptionCliProvider("codex-cli")).toBe(true);
    // The API-key providers must keep going through the normal key path, or a
    // user with credit would find their key ignored.
    expect(isSubscriptionCliProvider("anthropic")).toBe(false);
    expect(isSubscriptionCliProvider("openai")).toBe(false);
    expect(isSubscriptionCliProvider("ollama")).toBe(false);
  });

  it("offers at least one model per CLI, or it cannot appear in the picker", () => {
    for (const cli of SUBSCRIPTION_CLIS) {
      expect(cli.models.length).toBeGreaterThan(0);
      for (const model of cli.models) {
        expect(model.id.trim()).not.toBe("");
        expect(model.label.trim()).not.toBe("");
      }
    }
  });

  it("looks for credentials in every platform's location", () => {
    // Checking only the POSIX path made a signed-in Windows user look signed
    // out: Copilot writes under .config on POSIX and AppData on Windows.
    for (const cli of SUBSCRIPTION_CLIS) {
      expect(cli.credentialHints.length).toBeGreaterThan(0);
      for (const hint of cli.credentialHints) {
        expect(hint.startsWith("/")).toBe(false); // relative to the home dir
        expect(hint.trim()).not.toBe("");
      }
    }
    const copilot = getSubscriptionCli("copilot-cli")!;
    expect(copilot.credentialHints.some((h) => h.includes("AppData"))).toBe(true);
    expect(copilot.credentialHints.some((h) => h.startsWith(".config/"))).toBe(true);
  });

  it("names an install and a login command for every CLI", () => {
    // These strings are what the settings panel tells the user to run. An empty
    // one leaves someone stuck with "not installed" and no way forward.
    for (const cli of SUBSCRIPTION_CLIS) {
      expect(cli.installCommand.trim()).not.toBe("");
      expect(cli.loginCommand.trim()).not.toBe("");
      expect(cli.docsUrl).toMatch(/^https:\/\//);
    }
  });
});

describe("building argv", () => {
  it("passes the chosen model through to each CLI's own flag", () => {
    expect(claude.buildArgs("hi", "claude-opus-4-6")).toContain("--model");
    expect(claude.buildArgs("hi", "claude-opus-4-6")).toContain("claude-opus-4-6");
    expect(codex.buildArgs("hi", "gpt-5.1")).toContain("--model");
    // Gemini spells it -m, not --model.
    expect(gemini.buildArgs("hi", "gemini-2.5-pro")).toContain("-m");
  });

  it("omits the model flag when no model was chosen", () => {
    // Passing an empty --model would make the CLI error rather than use its
    // own default.
    expect(claude.buildArgs("hi", undefined)).not.toContain("--model");
    expect(codex.buildArgs("hi", undefined)).not.toContain("--model");
  });

  it("keeps a prompt starting with a dash from being read as a flag", () => {
    const args = codex.buildArgs("--help me name this function", "gpt-5.1");
    // It must be last and positional; anywhere earlier and argv parsing eats it.
    expect(args[args.length - 1]).toBe("--help me name this function");
  });

  it("bounds Claude Code to a single turn", () => {
    // Without this the CLI is free to start using tools and editing files —
    // not what a chat box asked for.
    const args = claude.buildArgs("hi", undefined);
    expect(args).toContain("--max-turns");
    expect(args[args.indexOf("--max-turns") + 1]).toBe("1");
  });

  it("asks Claude Code for stream-json, which requires --verbose", () => {
    const args = claude.buildArgs("hi", undefined);
    expect(args).toContain("stream-json");
    expect(args).toContain("--verbose");
  });
});

describe("reading Claude Code's output", () => {
  it("takes the text out of an assistant message", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Hello" },
          { type: "thinking", thinking: "hmm" },
          { type: "text", text: " there" },
        ],
      },
    });
    expect(claude.parseLine(line)).toEqual({ text: "Hello there" });
  });

  it("takes usage and cost from the result event", () => {
    const line = JSON.stringify({
      type: "result",
      subtype: "success",
      result: "the answer",
      total_cost_usd: 0.0123,
      usage: { input_tokens: 40, output_tokens: 9 },
    });
    expect(claude.parseLine(line)).toEqual({
      final: "the answer",
      inputTokens: 40,
      outputTokens: 9,
      costUsd: 0.0123,
    });
  });

  it("treats a non-success result as a failure", () => {
    // The CLI exits 0 when it hits its turn limit. Without this the user gets
    // a blank reply and no explanation.
    const line = JSON.stringify({
      type: "result",
      subtype: "error_max_turns",
      result: "hit the turn limit",
    });
    expect(claude.parseLine(line)).toEqual({ error: "hit the turn limit" });
  });

  it("ignores the events that are noise in a chat box", () => {
    expect(claude.parseLine(JSON.stringify({ type: "system", subtype: "init" }))).toBeNull();
    expect(claude.parseLine("")).toBeNull();
    expect(claude.parseLine("   ")).toBeNull();
  });

  it("shows a line that is not JSON rather than swallowing it", () => {
    // A warning or a banner still tells the user something.
    expect(claude.parseLine("npm warn deprecated foo")).toEqual({
      text: "npm warn deprecated foo",
    });
  });
});

describe("reading Codex's output", () => {
  it("accepts the flat event shape", () => {
    const line = JSON.stringify({ type: "agent_message", message: "hi" });
    expect(codex.parseLine(line)).toEqual({ text: "hi" });
  });

  it("accepts the nested { msg } envelope too", () => {
    // Codex has shipped both. Betting on one version is how this silently
    // stops working after an upgrade.
    const line = JSON.stringify({
      id: "1",
      msg: { type: "agent_message", message: "hi" },
    });
    expect(codex.parseLine(line)).toEqual({ text: "hi" });
  });

  it("streams deltas", () => {
    const line = JSON.stringify({
      msg: { type: "agent_message_delta", delta: "par" },
    });
    expect(codex.parseLine(line)).toEqual({ text: "par" });
  });

  it("surfaces an error event", () => {
    const line = JSON.stringify({
      msg: { type: "error", message: "not signed in" },
    });
    expect(codex.parseLine(line)).toEqual({ error: "not signed in" });
  });

  it("reads token counts under either name", () => {
    const line = JSON.stringify({
      msg: { type: "token_count", info: { input_tokens: 12, output_tokens: 3 } },
    });
    expect(codex.parseLine(line)).toEqual({ inputTokens: 12, outputTokens: 3 });
  });
});

describe("reading a plain-text CLI", () => {
  it("passes prose straight through", () => {
    expect(gemini.parseLine("The capital of France is Paris.")).toEqual({
      text: "The capital of France is Paris.",
    });
  });

  it("drops blank lines so the reply is not full of gaps", () => {
    expect(gemini.parseLine("")).toBeNull();
  });
});
