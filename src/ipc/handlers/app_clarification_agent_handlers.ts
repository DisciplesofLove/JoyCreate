/**
 * App Clarification Agent — IPC handlers.
 *
 * Powers the Quick Start cockpit on the workspace home page. Asks the user
 * 1–4 follow-up questions when their build prompt is too thin, then emits a
 * structured "build brief" the renderer uses to drive `createApp` +
 * `streamMessage` with a sharper system prompt.
 *
 * Channels (renderer → main):
 *   - `app-clarification:run`    { prompt, intent?, config?, model?, provider? }
 *      → returns ClarificationRunResult
 *   - `app-clarification:answer` { runId, answer }   (no return)
 *   - `app-clarification:cancel` { runId }           (no return)
 *
 * Channels (main → renderer):
 *   - `app-clarification:event`  { runId, kind, ... }
 *
 * Failures throw — never return `{ success: false }` envelopes.
 */

import { ipcMain, type IpcMainInvokeEvent } from "electron";
import { z } from "zod";
import { tool, stepCountIs, streamText } from "ai";
import log from "electron-log";
import { randomUUID } from "node:crypto";

import { readSettings } from "../../main/settings";
import { getModelClient } from "../utils/get_model_client";
import { createOllamaProvider } from "../utils/ollama_provider";
import { safeSend } from "../utils/safe_sender";

const logger = log.scope("app-clarification");

/** Hard wall-clock cap for the entire agent run. Prevents hung streams
 *  (network failure, model never calling propose_brief) from blocking the
 *  Quick Start cockpit indefinitely. */
const RUN_TIMEOUT_MS = 60_000;

/** Local Ollama fallback model — small, fast, tool-capable. Only attempted
 *  when no cloud provider key is configured. */
const OLLAMA_FALLBACK_MODEL =
  process.env.JOY_OLLAMA_FALLBACK_MODEL ?? "llama3.1:8b";
const OLLAMA_BASE_URL =
  process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";

async function probeOllama(): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1500);
    const res = await fetch(`${OLLAMA_BASE_URL}/api/tags`, {
      signal: ctrl.signal,
    });
    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Types shared with the renderer (also re-declared in the renderer client).
// ---------------------------------------------------------------------------

export type QuickStartProjectType =
  | "app"
  | "website"
  | "game"
  | "ui-skin"
  | "agent-ui"
  | "mobile"
  | "desktop";

export interface QuickStartConfig {
  projectType?: QuickStartProjectType;
  framework?: string;
  uiLibrary?: string;
  category?: string;
  templateId?: string;
  buildMode?: string;
  styleHints?: { color?: string; font?: string; mood?: string };
  deploymentTargets?: string[];
  /** Toggleable feature areas the user explicitly wants in the build,
   *  e.g. "auth", "database", "payments", "analytics", "seo", "i18n",
   *  "web3", "realtime", "ai-agents", "mobile-export". */
  features?: string[];
  knowledgeNotes?: string;
}

export interface BuildBrief {
  title: string;
  summary: string;
  projectType: QuickStartProjectType;
  framework: string;
  uiLibrary: string;
  category: string;
  templateId?: string;
  buildMode: string;
  styleHints: { color?: string; font?: string; mood?: string };
  deploymentTargets: string[];
  features: string[];
  knowledgeNotes: string;
  refinedPrompt: string;
}

export interface ClarificationRunResult {
  runId: string;
  brief: BuildBrief;
  /** False when the user cancelled or the agent aborted before proposing. */
  finished: boolean;
}

export type ClarificationEventKind =
  | "started"
  | "thinking"
  | "question"
  | "answer-received"
  | "brief"
  | "error"
  | "done";

export interface ClarificationEvent {
  runId: string;
  kind: ClarificationEventKind;
  message?: string;
  question?: {
    text: string;
    suggestions?: string[];
    allowFreeform?: boolean;
  };
  brief?: BuildBrief;
  error?: string;
}

interface RunOptions {
  prompt: string;
  config?: QuickStartConfig;
  model?: string;
  provider?: string;
}

// ---------------------------------------------------------------------------
// Per-run state — answers are resolved by the `answer` channel.
// ---------------------------------------------------------------------------

interface ActiveRun {
  abort: AbortController;
  pendingAnswer: ((answer: string) => void) | null;
}

const activeRuns = new Map<string, ActiveRun>();

// ---------------------------------------------------------------------------
// Heuristic skip — when the prompt is rich AND the chips already cover the
// minimum fields, we can let the LLM jump straight to `propose_brief`.
// ---------------------------------------------------------------------------

function chipsCoverEnough(config: QuickStartConfig | undefined): boolean {
  if (!config) return false;
  return Boolean(config.projectType && config.framework);
}

function isPromptRich(prompt: string): boolean {
  const words = prompt.trim().split(/\s+/).filter(Boolean);
  return words.length >= 25;
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

function buildSystemPrompt(opts: {
  prompt: string;
  config: QuickStartConfig;
  skipQuestions: boolean;
}): string {
  const cfg = opts.config;
  const cfgLines: string[] = [];
  if (cfg.projectType) cfgLines.push(`projectType: ${cfg.projectType}`);
  if (cfg.framework) cfgLines.push(`framework: ${cfg.framework}`);
  if (cfg.uiLibrary) cfgLines.push(`uiLibrary: ${cfg.uiLibrary}`);
  if (cfg.category) cfgLines.push(`category: ${cfg.category}`);
  if (cfg.templateId) cfgLines.push(`templateId: ${cfg.templateId}`);
  if (cfg.buildMode) cfgLines.push(`buildMode: ${cfg.buildMode}`);
  if (cfg.styleHints?.color) cfgLines.push(`styleColor: ${cfg.styleHints.color}`);
  if (cfg.styleHints?.font) cfgLines.push(`styleFont: ${cfg.styleHints.font}`);
  if (cfg.styleHints?.mood) cfgLines.push(`styleMood: ${cfg.styleHints.mood}`);
  if (cfg.deploymentTargets && cfg.deploymentTargets.length > 0) {
    cfgLines.push(`deploymentTargets: ${cfg.deploymentTargets.join(", ")}`);
  }
  if (cfg.features && cfg.features.length > 0) {
    cfgLines.push(`features (must include): ${cfg.features.join(", ")}`);
  }
  if (cfg.knowledgeNotes) cfgLines.push(`knowledgeNotes: provided (${cfg.knowledgeNotes.length} chars)`);

  return [
    "You are JoyCreate's App Builder Scoping Agent.",
    "Your single goal is to gather just enough context to produce an excellent build brief — no code, no implementation.",
    "",
    "Rules:",
    `- Ask AT MOST 4 short follow-up questions, only when the answer is genuinely missing.`,
    "- Never re-ask anything the user already supplied via chips/config below.",
    "- If the project type or framework supplied by the chips obviously contradicts the prompt (e.g. chip 'ui-skin' with prompt 'multiplayer FPS'), ask ONE clarifying question to reconcile.",
    "- Always finish by calling the `propose_brief` tool with a complete build brief.",
    "- The `refinedPrompt` field must be a clean, implementation-ready brief the next coding agent can build from. Include the user's original intent verbatim, plus any details gathered.",
    "- Pick reasonable defaults silently when the user is ambiguous on minor details.",
    opts.skipQuestions
      ? "- The user supplied enough up-front context. Skip questions and call `propose_brief` immediately."
      : "- Prefer fewer questions. Bundle related questions together. If the prompt + config already cover the essentials, call `propose_brief` immediately.",
    "",
    "User prompt:",
    `"""${opts.prompt}"""`,
    "",
    "User-supplied config from Quick Start chips:",
    cfgLines.length > 0 ? cfgLines.map((l) => `- ${l}`).join("\n") : "- (none)",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Default brief — used when the LLM never proposes one (cancelled mid-run).
// ---------------------------------------------------------------------------

function defaultBrief(opts: RunOptions): BuildBrief {
  const cfg = opts.config ?? {};
  return {
    title: "",
    summary: opts.prompt.slice(0, 240),
    projectType: cfg.projectType ?? "app",
    framework: cfg.framework ?? "react",
    uiLibrary: cfg.uiLibrary ?? "shadcn",
    category: cfg.category ?? "other",
    templateId: cfg.templateId,
    buildMode: cfg.buildMode ?? "chat",
    styleHints: cfg.styleHints ?? {},
    deploymentTargets: cfg.deploymentTargets ?? ["web"],
    features: cfg.features ?? [],
    knowledgeNotes: cfg.knowledgeNotes ?? "",
    refinedPrompt: opts.prompt,
  };
}

// ---------------------------------------------------------------------------
// Main run loop
// ---------------------------------------------------------------------------

async function runAgent(
  event: IpcMainInvokeEvent,
  opts: RunOptions,
): Promise<ClarificationRunResult> {
  const prompt = (opts.prompt ?? "").trim();
  if (!prompt) {
    throw new Error("Empty prompt — describe what you want to build first.");
  }

  const runId = randomUUID();
  const abort = new AbortController();
  const state: ActiveRun = { abort, pendingAnswer: null };
  activeRuns.set(runId, state);

  const emit = (ev: Omit<ClarificationEvent, "runId">) => {
    safeSend(event.sender, "app-clarification:event", { runId, ...ev });
  };

  emit({ kind: "started", message: "Scoping agent started" });

  // Resolve LLM with a graceful fallback chain:
  //   1. user-selected model (or auto)
  //   2. local Ollama if running
  //   3. give up gracefully — return the prompt as the brief, no error
  const settings = readSettings();
  const modelSelection =
    opts.model && opts.provider
      ? { provider: opts.provider, name: opts.model }
      : settings.selectedModel ?? { provider: "auto", name: "auto" };
  let modelClient: { model: import("@ai-sdk/provider").LanguageModelV2 } | null =
    null;
  try {
    const resolved = await getModelClient(modelSelection, settings);
    modelClient = resolved.modelClient;
  } catch (err) {
    logger.warn(
      `Primary model resolution failed (${(err as Error).message}); trying local Ollama fallback.`,
    );
    if (await probeOllama()) {
      try {
        const provider = createOllamaProvider({
          baseURL: OLLAMA_BASE_URL,
        });
        modelClient = { model: provider(OLLAMA_FALLBACK_MODEL) };
        emit({
          kind: "thinking",
          message: `Using local Ollama (${OLLAMA_FALLBACK_MODEL}) — no cloud key configured.`,
        });
      } catch (ollamaErr) {
        logger.warn(
          `Ollama fallback failed: ${(ollamaErr as Error).message}`,
        );
      }
    }
  }

  // No model available anywhere — short-circuit to the default brief so the
  // user can still proceed. The cockpit will treat this as a normal finish
  // and continue with the raw prompt.
  if (!modelClient) {
    activeRuns.delete(runId);
    const brief = defaultBrief(opts);
    emit({
      kind: "thinking",
      message:
        "No language model available — skipping clarification and using your prompt as-is. Add an API key in Settings or start Ollama for smarter scoping.",
    });
    emit({ kind: "brief", brief });
    emit({ kind: "done", message: "Using prompt as brief", brief });
    return { runId, brief, finished: true };
  }

  const config = opts.config ?? {};
  const skipQuestions = isPromptRich(prompt) && chipsCoverEnough(config);
  let finalBrief: BuildBrief | null = null;

  // ---- tools ----------------------------------------------------------------

  const ask_user_question = tool({
    description:
      "Ask the user a single short follow-up question. Use this only when information is genuinely missing. Returns the user's answer text.",
    inputSchema: z.object({
      question: z.string().min(2).describe("One short question, plain language."),
      suggestions: z
        .array(z.string())
        .max(6)
        .optional()
        .describe("Optional tappable answer chips (1–6 short suggestions)."),
      allowFreeform: z
        .boolean()
        .optional()
        .describe("Whether the user may type a freeform answer (default true)."),
    }),
    execute: async ({ question, suggestions, allowFreeform }) => {
      emit({
        kind: "question",
        question: {
          text: question,
          suggestions,
          allowFreeform: allowFreeform !== false,
        },
      });

      const answer = await new Promise<string>((resolve, reject) => {
        if (state.abort.signal.aborted) {
          reject(new Error("aborted"));
          return;
        }
        state.pendingAnswer = (a) => {
          state.pendingAnswer = null;
          resolve(a);
        };
        state.abort.signal.addEventListener(
          "abort",
          () => {
            if (state.pendingAnswer) {
              state.pendingAnswer = null;
              reject(new Error("aborted"));
            }
          },
          { once: true },
        );
      });

      emit({ kind: "answer-received", message: answer });
      return { answer };
    },
  });

  const QuickStartProjectTypeSchema = z.enum([
    "app",
    "website",
    "game",
    "ui-skin",
    "agent-ui",
    "mobile",
    "desktop",
  ]);

  const propose_brief = tool({
    description:
      "Finalise the build brief. Call this LAST when you have enough information. Do not call any tool after this.",
    inputSchema: z.object({
      title: z.string().min(1).describe("Short app title (3–6 words)."),
      summary: z.string().min(1).describe("One-sentence description."),
      projectType: QuickStartProjectTypeSchema,
      framework: z.string().min(1),
      uiLibrary: z.string().min(1),
      category: z.string().min(1),
      templateId: z.string().optional(),
      buildMode: z.string().min(1),
      styleHints: z
        .object({
          color: z.string().optional(),
          font: z.string().optional(),
          mood: z.string().optional(),
        })
        .optional(),
      deploymentTargets: z.array(z.string()).optional(),
      features: z
        .array(z.string())
        .optional()
        .describe(
          "Capability areas to include (auth, database, payments, analytics, seo, i18n, web3, realtime, ai-agents, mobile-export, ...). Echo any features the user requested in chips, plus any you inferred from the prompt.",
        ),
      knowledgeNotes: z.string().optional(),
      refinedPrompt: z
        .string()
        .min(1)
        .describe(
          "The implementation-ready brief the coding agent will build from.",
        ),
    }),
    execute: async (input) => {
      const brief: BuildBrief = {
        title: input.title,
        summary: input.summary,
        projectType: input.projectType,
        framework: input.framework,
        uiLibrary: input.uiLibrary,
        category: input.category,
        templateId: input.templateId,
        buildMode: input.buildMode,
        styleHints: input.styleHints ?? {},
        deploymentTargets: input.deploymentTargets ?? ["web"],
        features: input.features ?? [],
        knowledgeNotes: input.knowledgeNotes ?? "",
        refinedPrompt: input.refinedPrompt,
      };
      finalBrief = brief;
      emit({ kind: "brief", brief });
      return { ok: true };
    },
  });

  // ---- run ------------------------------------------------------------------

  // Hard wall-clock timeout — abort the run if it stalls (network failure,
  // model never calls propose_brief). The cockpit will then receive a
  // `done` event with the default brief and stop spinning.
  const timeoutHandle = setTimeout(() => {
    if (!finalBrief && !abort.signal.aborted) {
      logger.warn(
        `Clarification run ${runId} exceeded ${RUN_TIMEOUT_MS}ms — aborting.`,
      );
      emit({
        kind: "thinking",
        message: "Taking too long — falling back to your raw prompt.",
      });
      abort.abort();
    }
  }, RUN_TIMEOUT_MS);

  try {
    const stream = streamText({
      model: modelClient.model,
      system: buildSystemPrompt({ prompt, config, skipQuestions }),
      messages: [
        {
          role: "user",
          content:
            "Scope this build. Ask follow-up questions only if genuinely needed, then call propose_brief.",
        },
      ],
      tools: { ask_user_question, propose_brief },
      stopWhen: stepCountIs(12),
      temperature: 0.4,
      abortSignal: abort.signal,
      onError: (err) => {
        const msg =
          (err as { error?: { message?: string } })?.error?.message ??
          String(err);
        logger.error("clarification stream error", msg);
        emit({ kind: "error", error: msg });
      },
    });

    for await (const part of stream.fullStream) {
      if (abort.signal.aborted) break;
      switch (part.type) {
        case "reasoning-delta":
          emit({ kind: "thinking", message: part.text });
          break;
        case "error": {
          const msg =
            (part as { error?: { message?: string } })?.error?.message ??
            String((part as { error?: unknown })?.error);
          emit({ kind: "error", error: msg });
          break;
        }
        default:
          break;
      }
      if (finalBrief) break; // propose_brief reached — stop early
    }
  } catch (err) {
    if (!abort.signal.aborted) {
      const msg = (err as Error).message;
      emit({ kind: "error", error: msg });
      activeRuns.delete(runId);
      clearTimeout(timeoutHandle);
      throw new Error(`Clarification agent failed: ${msg}`);
    }
  }

  clearTimeout(timeoutHandle);
  activeRuns.delete(runId);

  const brief = finalBrief ?? defaultBrief(opts);
  // We always have a usable brief (defaultBrief is the floor), so report
  // `finished: true` to keep the cockpit non-blocking.
  const finished = true;
  emit({
    kind: "done",
    message: finalBrief ? "Brief ready" : "Using prompt as brief",
    brief,
  });

  return { runId, brief, finished };
}

// ---------------------------------------------------------------------------
// IPC registration
// ---------------------------------------------------------------------------

export function registerAppClarificationAgentHandlers(): void {
  ipcMain.handle(
    "app-clarification:run",
    async (event: IpcMainInvokeEvent, opts: RunOptions) => {
      return runAgent(event, opts ?? { prompt: "" });
    },
  );

  ipcMain.handle(
    "app-clarification:answer",
    async (
      _event: IpcMainInvokeEvent,
      payload: { runId: string; answer: string },
    ) => {
      const run = activeRuns.get(payload?.runId);
      if (!run) {
        throw new Error(`No active clarification run: ${payload?.runId}`);
      }
      if (!run.pendingAnswer) {
        // Late answer — silently drop instead of throwing so race conditions
        // (user clicks twice) don't blow up the UI.
        logger.warn("answer arrived but no pending question", payload.runId);
        return;
      }
      run.pendingAnswer(payload.answer ?? "");
    },
  );

  ipcMain.handle(
    "app-clarification:cancel",
    async (_event: IpcMainInvokeEvent, runId: string) => {
      const run = activeRuns.get(runId);
      if (!run) {
        // Already finished — no-op.
        return;
      }
      run.abort.abort();
      activeRuns.delete(runId);
    },
  );
}
