/**
 * Browser Agent runner — drives the active webview through a ReAct loop.
 *
 * Lives in the renderer because it needs direct access to the
 * Electron <webview> instance (loadURL, executeJavaScript, goBack...).
 * Planning is delegated to the main process via `browserAgentClient`.
 */

import { browserAgentClient } from "@/ipc/clients/browser_agent_client";
import { agentMemoryClient } from "@/ipc/clients/agent_memory_client";
import {
  AGENT_OBSERVE_SCRIPT,
  buildClickScript,
  buildExtractScript,
  buildFillScript,
  buildPressKeyScript,
  buildScrollScript,
} from "@/lib/browser_agent_dom_script";
import type {
  BrowserAgentAction,
  BrowserAgentObservation,
  BrowserAgentRunState,
  BrowserAgentTurn,
} from "@/types/browser_agent";

const MAX_STEPS_DEFAULT = 25;
const MAX_LOOP_GUARD_MS = 5 * 60_000;

export interface BrowserAgentRunnerOptions {
  /** Provider that returns the active webview each step (may change). */
  getActiveWebview: () => Electron.WebviewTag | null;
  /** Open a new tab. */
  openTab: (url: string, opts?: { background?: boolean }) => void;
  /** Optional agent id for save_memory tool. */
  agentId?: number;
  /** Max planning steps before forced stop. */
  maxSteps?: number;
  /** Streaming callback for UI updates. */
  onStateChange?: (state: BrowserAgentRunState) => void;
}

const ALLOWED_TOOLS = ["save_memory"] as const;
type AllowedTool = (typeof ALLOWED_TOOLS)[number];

export class BrowserAgentRunner {
  private state: BrowserAgentRunState = {
    status: "idle",
    step: 0,
    task: "",
    history: [],
  };
  private cancelled = false;
  private startedAt = 0;

  constructor(private readonly opts: BrowserAgentRunnerOptions) {}

  getState(): BrowserAgentRunState {
    return this.state;
  }

  stop(): void {
    if (this.state.status === "running") {
      this.cancelled = true;
      this.setState({ status: "stopping" });
    }
  }

  async run(task: string): Promise<BrowserAgentRunState> {
    if (this.state.status === "running") {
      throw new Error("Agent is already running");
    }
    this.cancelled = false;
    this.startedAt = Date.now();
    this.setState({
      status: "running",
      step: 0,
      task: task.trim(),
      history: [],
      finalAnswer: undefined,
      errorMessage: undefined,
    });

    const maxSteps = this.opts.maxSteps ?? MAX_STEPS_DEFAULT;

    try {
      // Initial observation BEFORE the first plan call.
      let observation = await this.observe(0, "Agent started");

      for (let step = 1; step <= maxSteps; step++) {
        if (this.cancelled) break;
        if (Date.now() - this.startedAt > MAX_LOOP_GUARD_MS) {
          throw new Error("Agent exceeded 5-minute loop guard");
        }

        const action = await browserAgentClient.planStep({
          task: this.state.task,
          history: this.state.history,
          observation,
          allowedTools: [...ALLOWED_TOOLS],
        });

        // Record the planned action immediately so the UI streams it.
        const turn: BrowserAgentTurn = { step, action, observation: null };
        this.setState({
          step,
          history: [...this.state.history, turn],
        });

        if (action.action === "done") {
          this.setState({
            status: "done",
            finalAnswer:
              action.answer?.trim() || "(agent finished without an answer)",
          });
          return this.state;
        }

        // Execute the action.
        const result = await this.execute(action);
        observation = await this.observe(step, result);

        // Backfill observation onto the just-recorded turn.
        const updated = [...this.state.history];
        updated[updated.length - 1] = { ...turn, observation };
        this.setState({ history: updated });
      }

      if (this.cancelled) {
        this.setState({ status: "stopped" });
      } else {
        this.setState({
          status: "error",
          errorMessage: `Agent reached max step count (${maxSteps}) without finishing`,
        });
      }
      return this.state;
    } catch (err) {
      this.setState({
        status: "error",
        errorMessage: (err as Error).message,
      });
      return this.state;
    }
  }

  // ── private ───────────────────────────────────────────────────────────

  private setState(patch: Partial<BrowserAgentRunState>): void {
    this.state = { ...this.state, ...patch };
    this.opts.onStateChange?.(this.state);
  }

  private async waitForReady(wv: Electron.WebviewTag, ms = 2500): Promise<void> {
    try {
      if (!wv.isLoading()) return;
    } catch {
      /* not attached yet */
    }
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        wv.removeEventListener("did-stop-loading", finish as EventListener);
        wv.removeEventListener("dom-ready", finish as EventListener);
        resolve();
      };
      wv.addEventListener("did-stop-loading", finish as EventListener, {
        once: true,
      });
      wv.addEventListener("dom-ready", finish as EventListener, { once: true });
      setTimeout(finish, ms);
    });
  }

  private async observe(
    step: number,
    result: string,
  ): Promise<BrowserAgentObservation> {
    const wv = this.opts.getActiveWebview();
    if (!wv) {
      return {
        step,
        url: "about:blank",
        title: "",
        text: "",
        elements: [],
        result: `${result} | ERROR: no active tab`,
      };
    }
    await this.waitForReady(wv);
    try {
      const raw = await wv.executeJavaScript(AGENT_OBSERVE_SCRIPT);
      const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
      return {
        step,
        url: parsed.url ?? wv.getURL?.() ?? "",
        title: parsed.title ?? "",
        text: parsed.text ?? "",
        elements: parsed.elements ?? [],
        result,
      };
    } catch (err) {
      return {
        step,
        url: wv.getURL?.() ?? "",
        title: "",
        text: "",
        elements: [],
        result: `${result} | OBSERVE_ERROR: ${(err as Error).message}`,
      };
    }
  }

  private async execute(action: BrowserAgentAction): Promise<string> {
    const wv = this.opts.getActiveWebview();
    if (!wv) return "ERROR: no active webview";
    const p = (action.params ?? {}) as Record<string, unknown>;

    try {
      switch (action.action) {
        case "navigate": {
          const url = String(p.url ?? "").trim();
          if (!url) return "ERROR: navigate requires params.url";
          await wv.loadURL(url);
          await this.waitForReady(wv, 4000);
          return `OK: navigated to ${url}`;
        }
        case "click": {
          const idx = Number(p.index);
          if (!Number.isFinite(idx)) return "ERROR: click requires params.index";
          const out = await wv.executeJavaScript(buildClickScript(idx));
          await this.waitForReady(wv, 1500);
          return String(out);
        }
        case "fill": {
          const idx = Number(p.index);
          const value = String(p.value ?? "");
          if (!Number.isFinite(idx)) return "ERROR: fill requires params.index";
          const out = await wv.executeJavaScript(buildFillScript(idx, value));
          return String(out);
        }
        case "press_key": {
          const key = String(p.key ?? "Enter");
          const idx = typeof p.index === "number" ? p.index : undefined;
          const out = await wv.executeJavaScript(buildPressKeyScript(key, idx));
          await this.waitForReady(wv, 1500);
          return String(out);
        }
        case "scroll": {
          const dir = String(p.direction ?? "down") as
            | "up"
            | "down"
            | "top"
            | "bottom";
          const amt =
            typeof p.amount === "number" ? (p.amount as number) : undefined;
          const out = await wv.executeJavaScript(buildScrollScript(dir, amt));
          return String(out);
        }
        case "extract": {
          const sel =
            typeof p.selector === "string" ? (p.selector as string) : undefined;
          const raw = await wv.executeJavaScript(buildExtractScript(sel));
          try {
            const parsed = JSON.parse(String(raw)) as
              | { ok: true; text: string }
              | { ok: false; error: string };
            if (parsed.ok) return `OK: extracted ${parsed.text.length} chars`;
            return `ERROR: ${parsed.error}`;
          } catch {
            return `OK: ${String(raw).slice(0, 200)}`;
          }
        }
        case "wait": {
          const ms = Math.min(
            Number(p.ms) || 1000,
            10_000, // hard cap so the agent can't sleep forever
          );
          await new Promise((r) => setTimeout(r, ms));
          return `OK: waited ${ms}ms`;
        }
        case "back": {
          if (!wv.canGoBack?.()) return "ERROR: cannot go back";
          wv.goBack();
          await this.waitForReady(wv, 3000);
          return "OK: went back";
        }
        case "forward": {
          if (!wv.canGoForward?.()) return "ERROR: cannot go forward";
          wv.goForward();
          await this.waitForReady(wv, 3000);
          return "OK: went forward";
        }
        case "reload": {
          wv.reload();
          await this.waitForReady(wv, 3000);
          return "OK: reloaded";
        }
        case "open_tab": {
          const url = String(p.url ?? "").trim();
          if (!url) return "ERROR: open_tab requires params.url";
          this.opts.openTab(url, { background: true });
          return `OK: opened new tab ${url}`;
        }
        case "tool_call": {
          const name = String(p.name ?? "") as AllowedTool;
          if (!ALLOWED_TOOLS.includes(name)) {
            return `ERROR: tool "${name}" is not allowed`;
          }
          return await this.callTool(name, (p.args as Record<string, unknown>) ?? {});
        }
        case "done":
          return "OK: done";
        default:
          return `ERROR: unknown action ${action.action}`;
      }
    } catch (err) {
      return `ERROR: ${(err as Error).message}`;
    }
  }

  private async callTool(
    name: AllowedTool,
    args: Record<string, unknown>,
  ): Promise<string> {
    switch (name) {
      case "save_memory": {
        if (!this.opts.agentId) {
          return "ERROR: save_memory requires an agentId in the runner config";
        }
        const content = String(args.content ?? "").trim();
        if (!content) return "ERROR: save_memory requires args.content";
        const importance =
          typeof args.importance === "number" ? args.importance : 0.6;
        await agentMemoryClient.createLTM({
          agentId: this.opts.agentId,
          category: "context",
          content,
          importance,
        });
        return `OK: saved memory (${content.length} chars)`;
      }
      default:
        return `ERROR: unhandled tool ${name as string}`;
    }
  }
}
