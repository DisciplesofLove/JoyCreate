/**
 * Kanban Agent Runtime
 * --------------------------------------------------------------------------
 * The pieces the kanban task executor needs to run a task *as an agent*
 * instead of as a single chat completion:
 *
 *   1. `loadKanbanAgentConfig`  — resolve a task's `agentId` to the agent's
 *      real configuration. Numeric ids come from the SQLite `agents` table
 *      (what the Agent Builder UI writes). Non-numeric ids fall back to the
 *      agent_builder_system JSON store (`userData/agents/agents.json`) and
 *      the legacy per-agent `userData/agents/<id>.json` file.
 *   2. `resolveKanbanLanguageModel` — map a model name + registry routing
 *      decision onto the app's provider/model client, so "cloud" selections
 *      actually go to a cloud provider instead of silently hitting Ollama.
 *   3. `buildOpenClawActionTools` — expose the OpenClaw ACTION_CATALOG as
 *      AI SDK tools, dispatched through `dispatchAction`. Every action is
 *      classified read / write / destructive; destructive actions (send,
 *      delete, publish, deploy, spend, spawn more autonomy, touch secrets)
 *      are never exposed to an unattended loop.
 *   4. `assembleKanbanToolSet` — MCP tools (via `buildMcpToolSet`, headless
 *      trusted mode — `denied` consent is still enforced inside the bridge)
 *      + OpenClaw actions, instrumented so every call is traced and every
 *      call honours the task's AbortController.
 *   5. `runKanbanAgentLoop` — bounded `generateText` tool loop
 *      (`stopWhen: stepCountIs(n)`), abortable mid-loop.
 *
 * Kept free of the executor's DB-writing side effects so it can be unit
 * tested in isolation; the executor wires the callbacks to the activity log.
 */

import { generateText, stepCountIs, tool, type ToolSet } from "ai";
import { z, type ZodTypeAny } from "zod";
import log from "electron-log";

import type { ActionDefinition } from "@/types/openclaw_autonomous_types";

const logger = log.scope("kanban_agent_runtime");

// =============================================================================
// TYPES
// =============================================================================

export interface KanbanAgentKanbanOptions {
  /** Set false to run this agent's kanban tasks without tools. */
  tools?: boolean;
  /**
   * Explicit allow-list of OpenClaw action ids (e.g. `["app.list"]`).
   * `undefined` = every non-destructive action, `[]` = no actions.
   */
  actionsAllow?: string[];
  /** Expose state-changing (but non-destructive) actions. Default true. */
  allowWriteActions?: boolean;
  /** Upper bound on model↔tool round trips. Default {@link DEFAULT_MAX_STEPS}. */
  maxSteps?: number;
}

export interface KanbanAgentConfig {
  source: "db" | "agent_store" | "legacy_file";
  agentId: string;
  name: string;
  systemPrompt: string | null;
  modelId: string | null;
  /** Normalised to the 0–2 range the AI SDK expects. */
  temperature: number | null;
  maxTokens: number | null;
  /** `undefined` = all enabled MCP tools; `[]` = none. */
  mcpToolsAllow?: string[];
  /** Restrict MCP to these server ids (from `config.tools.mcpServers`). */
  mcpServerIds?: number[];
  kanban: Required<
    Pick<KanbanAgentKanbanOptions, "tools" | "allowWriteActions" | "maxSteps">
  > &
    Pick<KanbanAgentKanbanOptions, "actionsAllow">;
}

export type ToolSource = "mcp" | "openclaw";

export interface KanbanToolTraceEntry {
  step: number;
  toolName: string;
  source: ToolSource;
  status: "ok" | "error" | "aborted";
  argsPreview: string;
  outputPreview?: string;
  error?: string;
  durationMs: number;
  startedAt: number;
}

export type ActionRisk = "read" | "write" | "destructive";

export const DEFAULT_MAX_STEPS = 8;
export const MAX_ALLOWED_STEPS = 25;
const PREVIEW_CHARS = 500;
/** A single tool result goes back into the model's context on every later step. */
export const MAX_TOOL_OUTPUT_CHARS = 6000;

export const DEFAULT_KANBAN_SYSTEM_PROMPT =
  "You are an AI agent executing tasks autonomously. Complete the task accurately and concisely. Provide clear, actionable output.";

// =============================================================================
// AGENT CONFIG LOADING
// =============================================================================

/**
 * `agents.temperature` is an INTEGER column. The agent editor persists it
 * scaled by 100 (70 → 0.7). Small values are treated as already-unscaled so
 * hand-edited rows still work. Same rule as `api_gateway/invoker.ts`.
 */
export function normalizeAgentTemperature(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  const t = n > 2 ? n / 100 : n;
  return Math.min(2, Math.max(0, t));
}

function clampSteps(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_MAX_STEPS;
  return Math.min(MAX_ALLOWED_STEPS, Math.floor(n));
}

function readKanbanOptions(raw: unknown): KanbanAgentConfig["kanban"] {
  const k = (
    raw && typeof raw === "object" ? raw : {}
  ) as KanbanAgentKanbanOptions;
  return {
    tools: k.tools !== false,
    allowWriteActions: k.allowWriteActions !== false,
    maxSteps: clampSteps(k.maxSteps ?? DEFAULT_MAX_STEPS),
    ...(Array.isArray(k.actionsAllow)
      ? { actionsAllow: k.actionsAllow.filter((s) => typeof s === "string") }
      : {}),
  };
}

function toServerIds(raw: unknown): number[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const ids = raw
    .map((v) => (typeof v === "number" ? v : Number.parseInt(String(v), 10)))
    .filter((n) => Number.isInteger(n) && n > 0);
  return ids.length > 0 ? ids : undefined;
}

function stringArray(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw.filter((s): s is string => typeof s === "string");
}

/** Shape of the columns we read from the SQLite `agents` table. */
export interface AgentDbRow {
  id: number;
  name: string;
  systemPrompt: string | null;
  modelId: string | null;
  temperature: number | null;
  maxTokens: number | null;
  configJson: unknown;
}

export function agentRowToKanbanConfig(row: AgentDbRow): KanbanAgentConfig {
  const cfg = (
    row.configJson && typeof row.configJson === "object" ? row.configJson : {}
  ) as {
    mcpToolsAllow?: unknown;
    tools?: { mcpServers?: unknown };
    custom?: { kanban?: unknown };
  };
  const mcpToolsAllow = stringArray(cfg.mcpToolsAllow);
  const mcpServerIds = toServerIds(cfg.tools?.mcpServers);
  return {
    source: "db",
    agentId: String(row.id),
    name: row.name,
    systemPrompt: row.systemPrompt?.trim() ? row.systemPrompt : null,
    modelId: row.modelId?.trim() ? row.modelId.trim() : null,
    temperature: normalizeAgentTemperature(row.temperature),
    maxTokens: row.maxTokens && row.maxTokens > 0 ? row.maxTokens : null,
    ...(mcpToolsAllow ? { mcpToolsAllow } : {}),
    ...(mcpServerIds ? { mcpServerIds } : {}),
    kanban: readKanbanOptions(cfg.custom?.kanban),
  };
}

/**
 * Map an agent from the agent_builder_system JSON store (or a legacy
 * per-agent file) onto the same config shape. Those agents keep the prompt
 * under `prompts.system` (or `systemPrompt`) and model settings under
 * `config`, with temperature already on the 0–1 scale.
 */
export function storedAgentToKanbanConfig(
  raw: Record<string, unknown>,
  source: "agent_store" | "legacy_file",
): KanbanAgentConfig {
  const config = (raw.config ?? {}) as Record<string, unknown>;
  const prompts = (raw.prompts ?? {}) as Record<string, unknown>;
  const metadata = (raw.metadata ?? {}) as Record<string, unknown>;
  const systemPrompt =
    (typeof prompts.system === "string" && prompts.system) ||
    (typeof raw.systemPrompt === "string" && raw.systemPrompt) ||
    null;
  const modelId =
    (typeof config.model === "string" && config.model) ||
    (typeof raw.modelId === "string" && raw.modelId) ||
    null;
  const maxTokens = Number(config.maxTokens ?? raw.maxTokens);
  const mcpToolsAllow = stringArray(config.mcpToolsAllow);
  return {
    source,
    agentId: String(raw.id ?? ""),
    name: typeof raw.name === "string" ? raw.name : String(raw.id ?? "agent"),
    systemPrompt,
    modelId,
    temperature: normalizeAgentTemperature(
      config.temperature ?? raw.temperature,
    ),
    maxTokens: Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : null,
    ...(mcpToolsAllow ? { mcpToolsAllow } : {}),
    kanban: readKanbanOptions(metadata.kanban ?? config.kanban),
  };
}

export interface AgentConfigLoaders {
  loadDbAgent: (id: number) => Promise<AgentDbRow | null>;
  readJsonFile: (relativePath: string) => Promise<unknown | null>;
}

async function defaultLoadDbAgent(id: number): Promise<AgentDbRow | null> {
  const { getDb } = await import("@/db");
  const { agents } = await import("@/db/schema");
  const { eq } = await import("drizzle-orm");
  const rows = await getDb()
    .select({
      id: agents.id,
      name: agents.name,
      systemPrompt: agents.systemPrompt,
      modelId: agents.modelId,
      temperature: agents.temperature,
      maxTokens: agents.maxTokens,
      configJson: agents.configJson,
    })
    .from(agents)
    .where(eq(agents.id, id))
    .limit(1);
  return (rows[0] as AgentDbRow | undefined) ?? null;
}

async function defaultReadJsonFile(
  relativePath: string,
): Promise<unknown | null> {
  try {
    const { app } = await import("electron");
    const path = await import("node:path");
    const fs = await import("node:fs/promises");
    const raw = await fs.readFile(
      path.join(app.getPath("userData"), "agents", relativePath),
      "utf-8",
    );
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

const SAFE_FILE_ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Resolve a kanban task's `agentId` to the agent's configuration.
 * Returns `null` when the agent cannot be found anywhere — the executor then
 * runs the task as a plain (agent-less) inference and records why.
 */
export async function loadKanbanAgentConfig(
  agentId: string | number | null | undefined,
  loaders: Partial<AgentConfigLoaders> = {},
): Promise<KanbanAgentConfig | null> {
  if (agentId === null || agentId === undefined) return null;
  const id = String(agentId).trim();
  if (!id) return null;
  const loadDbAgent = loaders.loadDbAgent ?? defaultLoadDbAgent;
  const readJsonFile = loaders.readJsonFile ?? defaultReadJsonFile;

  // 1. SQLite `agents` table (numeric ids).
  if (/^\d+$/.test(id)) {
    try {
      const row = await loadDbAgent(Number(id));
      if (row) return agentRowToKanbanConfig(row);
    } catch (err) {
      logger.warn(`Failed to load agent ${id} from DB:`, err);
    }
  }

  // Never let an id walk out of the agents directory.
  if (!SAFE_FILE_ID.test(id)) return null;

  // 2. agent_builder_system JSON store.
  const store = await readJsonFile("agents.json");
  if (Array.isArray(store)) {
    const match = store.find(
      (a) =>
        a && typeof a === "object" && String((a as { id?: unknown }).id) === id,
    );
    if (match) {
      return storedAgentToKanbanConfig(
        match as Record<string, unknown>,
        "agent_store",
      );
    }
  }

  // 3. Legacy per-agent file.
  const legacy = await readJsonFile(`${id}.json`);
  if (legacy && typeof legacy === "object") {
    return storedAgentToKanbanConfig(
      { id, ...(legacy as Record<string, unknown>) },
      "legacy_file",
    );
  }
  return null;
}

/**
 * A task runs the tool loop when it has a resolvable agent that hasn't
 * opted out, or when its type is `agent_task` (tools with default policy).
 */
export function shouldRunAgentic(
  task: { taskType?: string | null },
  agent: KanbanAgentConfig | null,
): boolean {
  if (agent) return agent.kanban.tools;
  return task.taskType === "agent_task";
}

// =============================================================================
// MODEL RESOLUTION
// =============================================================================

export interface ResolvedKanbanModel {
  model: { provider: string; name: string };
  /** What gets written to `openclaw_kanban_tasks.provider`. */
  providerLabel: string;
  local: boolean;
}

/**
 * Decide which provider actually serves `modelName`.
 *
 * The registry bridge only knows "ollama" / "cloud" / "peer", and it defaults
 * unknown names (e.g. an agent's `claude-sonnet-5`) to Ollama. Checking the
 * app's cloud model catalog first fixes both directions: catalog names go to
 * their cloud provider, Ollama tags stay local, and a registry "cloud" pick
 * that isn't in the catalog uses the user's selected cloud model instead of
 * being sent to Ollama under an "anthropic" label.
 */
export function resolveKanbanLanguageModel(
  modelName: string,
  selectionProvider: "ollama" | "cloud" | "peer",
  catalog: Record<string, Array<{ name: string }>>,
  selectedModel?: { provider: string; name: string } | null,
): ResolvedKanbanModel {
  const make = (provider: string, name: string): ResolvedKanbanModel => ({
    model: { provider, name },
    providerLabel: provider,
    local: provider === "ollama" || provider === "lmstudio",
  });

  // Explicit "provider/model".
  const slash = modelName.indexOf("/");
  if (slash > 0) {
    const provider = modelName.slice(0, slash);
    const name = modelName.slice(slash + 1);
    if (provider === "ollama" && name) return make("ollama", name);
    if (catalog[provider] && name) return make(provider, name);
  }

  // Known cloud catalog model.
  const owners = Object.entries(catalog)
    .filter(([, models]) => models.some((m) => m.name === modelName))
    .map(([provider]) => provider);
  if (owners.length > 0) {
    const preferred =
      (selectedModel && owners.includes(selectedModel.provider)
        ? selectedModel.provider
        : undefined) ??
      owners.find((p) => p !== "auto") ??
      owners[0];
    return make(preferred, modelName);
  }

  if (selectionProvider === "cloud") {
    if (selectedModel?.provider && selectedModel.name) {
      return make(selectedModel.provider, selectedModel.name);
    }
    return make("auto", modelName);
  }

  return make("ollama", modelName);
}

// =============================================================================
// OPENCLAW ACTION TOOLS
// =============================================================================

/** Whole categories an unattended loop must never touch. */
const DESTRUCTIVE_CATEGORIES = new Set(["secrets", "github", "agent_sharing"]);

/** Specific ids that are destructive but don't match the verb pattern. */
const DESTRUCTIVE_IDS = new Set([
  "agent_trigger.create", // schedules future autonomous runs
  "swarm.create",
  "orchestrator.submit_task",
  "app.set_env",
  "asset.create_api",
  "calendar.add_source",
  "calendar.create_event", // may sync to an external calendar
  "agent_stack.build", // creates triggers that run on their own
  "workflow.update", // can rewrite a live n8n workflow
]);

/**
 * Verbs that send, spend, publish, delete, deploy, start long-running work,
 * or otherwise leave the machine / can't be undone.
 */
const DESTRUCTIVE_VERB =
  /(^|_)(delete|remove|send|publish|push|deploy|install|download|stop|start|activate|deactivate|train|run|execute|cancel|submit|generate_codes|set_env|transfer|purchase|buy|mint)(_|$)/;

const READ_VERB =
  /^(get|list|status|stats|browse|search|query|match|read|detect|check|dashboard|templates)(_|$)|(^|_)status$|_stats$/;

const READ_CATEGORIES = new Set(["blockchain", "analytics"]);

export function classifyOpenClawAction(
  action: Pick<ActionDefinition, "id" | "category">,
): ActionRisk {
  if (DESTRUCTIVE_CATEGORIES.has(action.category)) return "destructive";
  if (DESTRUCTIVE_IDS.has(action.id)) return "destructive";
  const verb = action.id.slice(action.id.indexOf(".") + 1);
  if (DESTRUCTIVE_VERB.test(verb)) return "destructive";
  if (READ_VERB.test(verb)) return "read";
  if (
    READ_CATEGORIES.has(action.category) &&
    !/create|generate|update/.test(verb)
  ) {
    return "read";
  }
  return "write";
}

export function toolNameForAction(actionId: string): string {
  return `openclaw__${actionId.replace(/\./g, "__").replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

function actionParamsToZod(action: ActionDefinition): ZodTypeAny {
  const shape: Record<string, ZodTypeAny> = {};
  for (const p of action.parameters) {
    let s: ZodTypeAny;
    switch (p.type) {
      case "number":
        s = z.coerce.number();
        break;
      case "boolean":
        s = z.boolean();
        break;
      case "object":
        s = z.record(z.string(), z.unknown());
        break;
      default:
        s = z.string();
    }
    s = s.describe(p.description);
    shape[p.name] = p.required ? s : s.optional();
  }
  return z.object(shape);
}

export interface BuildActionToolsOptions {
  catalog: ActionDefinition[];
  dispatch: (
    actionId: string,
    params: Record<string, unknown>,
  ) => Promise<unknown>;
  allowList?: string[];
  allowWriteActions?: boolean;
}

export interface ActionToolSetResult {
  tools: ToolSet;
  exposed: string[];
  blocked: Array<{ actionId: string; risk: ActionRisk; reason: string }>;
}

export function buildOpenClawActionTools(
  opts: BuildActionToolsOptions,
): ActionToolSetResult {
  const allow = opts.allowList ? new Set(opts.allowList) : null;
  const allowWrite = opts.allowWriteActions !== false;
  const tools: ToolSet = {};
  const exposed: string[] = [];
  const blocked: ActionToolSetResult["blocked"] = [];

  for (const action of opts.catalog) {
    if (allow && !allow.has(action.id)) continue;
    const risk = classifyOpenClawAction(action);
    if (risk === "destructive") {
      // Even an explicit allow-list entry can't opt a destructive action
      // into an unattended run — there is no approval surface here yet.
      blocked.push({
        actionId: action.id,
        risk,
        reason:
          "destructive actions require human approval and never run unattended",
      });
      continue;
    }
    if (risk === "write" && !allowWrite) {
      blocked.push({
        actionId: action.id,
        risk,
        reason: "write actions disabled for this agent",
      });
      continue;
    }
    const name = toolNameForAction(action.id);
    tools[name] = tool({
      description: `[OpenClaw ${action.category}] ${action.description}`,
      inputSchema: actionParamsToZod(action),
      execute: async (args: unknown) =>
        opts.dispatch(action.id, {
          ...((args ?? {}) as Record<string, unknown>),
        }),
    });
    exposed.push(name);
  }
  return { tools, exposed, blocked };
}

// =============================================================================
// INSTRUMENTATION (trace + abort)
// =============================================================================

export function abortErrorFor(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof Error && reason.name === "AbortError") return reason;
  const err = new Error(typeof reason === "string" ? reason : "Aborted");
  err.name = "AbortError";
  return err;
}

function raceAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortErrorFor(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortErrorFor(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

export function preview(value: unknown, max = PREVIEW_CHARS): string {
  let s: string;
  if (typeof value === "string") {
    s = value;
  } else {
    try {
      s = JSON.stringify(value) ?? String(value);
    } catch {
      s = String(value);
    }
  }
  return s.length > max ? `${s.slice(0, max)}… [+${s.length - max} chars]` : s;
}

function truncateForModel(s: string): string {
  return `${s.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n[…output truncated: ${s.length - MAX_TOOL_OUTPUT_CHARS} more characters]`;
}

function boundOutput(value: unknown): unknown {
  if (typeof value === "string") {
    return value.length > MAX_TOOL_OUTPUT_CHARS
      ? truncateForModel(value)
      : value;
  }
  const s = preview(value, Number.MAX_SAFE_INTEGER);
  if (s.length <= MAX_TOOL_OUTPUT_CHARS) return value ?? null;
  return truncateForModel(s);
}

export interface InstrumentOptions {
  signal: AbortSignal;
  sourceOf: (toolName: string) => ToolSource;
  /** Current loop step (1-based); read at call time. */
  currentStep?: () => number;
  onToolCall?: (entry: KanbanToolTraceEntry) => void | Promise<void>;
  trace?: KanbanToolTraceEntry[];
}

type AnyToolExecute = (input: unknown, options: unknown) => unknown;

/**
 * Wrap every tool so that it (a) refuses to start once the task is aborted,
 * (b) is abandoned the moment the task is aborted mid-call, (c) is recorded
 * in the trace, and (d) returns a bounded result to the model.
 * Tools without an `execute` (client-side tools) are dropped — there is no
 * client in a background run.
 */
export function instrumentToolSet(
  tools: ToolSet,
  opts: InstrumentOptions,
): ToolSet {
  const out: ToolSet = {};
  for (const [name, t] of Object.entries(tools)) {
    const original = t.execute as AnyToolExecute | undefined;
    if (typeof original !== "function") continue;
    const source = opts.sourceOf(name);

    const execute = async (
      input: unknown,
      options: unknown,
    ): Promise<unknown> => {
      const startedAt = Date.now();
      const base = {
        step: opts.currentStep?.() ?? 0,
        toolName: name,
        source,
        argsPreview: preview(input),
        startedAt,
      };
      const record = async (entry: KanbanToolTraceEntry) => {
        opts.trace?.push(entry);
        try {
          await opts.onToolCall?.(entry);
        } catch (err) {
          logger.warn(`onToolCall hook failed for ${name}:`, err);
        }
      };

      if (opts.signal.aborted) {
        await record({
          ...base,
          status: "aborted",
          durationMs: 0,
          error: "task aborted",
        });
        throw abortErrorFor(opts.signal);
      }
      try {
        const result = await raceAbort(
          Promise.resolve(
            original(input, {
              ...((options ?? {}) as Record<string, unknown>),
              abortSignal: opts.signal,
            }),
          ),
          opts.signal,
        );
        const bounded = boundOutput(result);
        await record({
          ...base,
          status: "ok",
          outputPreview: preview(bounded),
          durationMs: Date.now() - startedAt,
        });
        return bounded;
      } catch (err) {
        await record({
          ...base,
          status: opts.signal.aborted ? "aborted" : "error",
          error: err instanceof Error ? err.message : String(err),
          durationMs: Date.now() - startedAt,
        });
        throw err;
      }
    };

    out[name] = { ...t, execute } as ToolSet[string];
  }
  return out;
}

// =============================================================================
// TOOL SET ASSEMBLY
// =============================================================================

export interface McpToolSetBuilderOptions {
  allowHeadless: boolean;
  serverIds?: number[];
  toolAllowList?: string[];
}

export interface AssembleToolSetDeps {
  buildMcpToolSet?: (
    opts: McpToolSetBuilderOptions,
  ) => Promise<{ tools: ToolSet; summary: unknown }>;
  catalog?: ActionDefinition[];
  dispatch?: (
    actionId: string,
    params: Record<string, unknown>,
  ) => Promise<unknown>;
}

export interface AssembledToolSet {
  tools: ToolSet;
  mcpToolNames: string[];
  actionToolNames: string[];
  blockedActions: ActionToolSetResult["blocked"];
  mcpSummary?: unknown;
  mcpError?: string;
}

export async function assembleKanbanToolSet(
  agent: KanbanAgentConfig | null,
  instrument: Omit<InstrumentOptions, "sourceOf">,
  deps: AssembleToolSetDeps = {},
): Promise<AssembledToolSet> {
  const kanban = agent?.kanban ?? readKanbanOptions(undefined);
  let mcpTools: ToolSet = {};
  let mcpSummary: unknown;
  let mcpError: string | undefined;

  // ── MCP tools ──
  const bridge = await import("@/lib/mcp_ai_bridge");
  const buildMcp = deps.buildMcpToolSet ?? bridge.buildMcpToolSet;
  const plan = bridge.planMcpAllowList(agent?.mcpToolsAllow);
  if (!plan.skip) {
    try {
      const res = await buildMcp({
        // Trusted internal caller with no window: `denied` consents are still
        // enforced by the bridge on every call; `ask` is treated as approved.
        allowHeadless: true,
        ...(agent?.mcpServerIds ? { serverIds: agent.mcpServerIds } : {}),
        ...plan.options,
      });
      mcpTools = res.tools;
      mcpSummary = res.summary;
    } catch (err) {
      mcpError = err instanceof Error ? err.message : String(err);
      logger.warn("MCP tools unavailable for kanban task:", err);
    }
  }

  // ── OpenClaw actions ──
  let catalog = deps.catalog;
  let dispatch = deps.dispatch;
  if (!catalog || !dispatch) {
    const actions = await import("@/lib/openclaw_actions");
    catalog = catalog ?? actions.ACTION_CATALOG;
    dispatch = dispatch ?? actions.dispatchAction;
  }
  const actionSet = buildOpenClawActionTools({
    catalog,
    dispatch,
    allowList: kanban.actionsAllow,
    allowWriteActions: kanban.allowWriteActions,
  });

  const mcpToolNames = Object.keys(mcpTools);
  const mcpNameSet = new Set(mcpToolNames);
  const tools = instrumentToolSet(
    { ...actionSet.tools, ...mcpTools },
    {
      ...instrument,
      sourceOf: (name) => (mcpNameSet.has(name) ? "mcp" : "openclaw"),
    },
  );

  return {
    tools,
    mcpToolNames,
    actionToolNames: actionSet.exposed,
    blockedActions: actionSet.blocked,
    ...(mcpSummary !== undefined ? { mcpSummary } : {}),
    ...(mcpError ? { mcpError } : {}),
  };
}

// =============================================================================
// AGENT LOOP
// =============================================================================

export interface AgentLoopUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface AgentLoopResult {
  content: string;
  steps: number;
  usage: AgentLoopUsage;
  finishReason?: string;
  /** Set when the model rejected tools and we retried without them. */
  toolsDisabledReason?: string;
}

type UsageLike = Record<string, number | undefined>;

export type GenerateTextFn = (args: Record<string, unknown>) => Promise<{
  text: string;
  steps?: unknown[];
  finishReason?: string;
  totalUsage?: UsageLike;
  usage?: UsageLike;
}>;

export interface AgentLoopOptions {
  model: unknown;
  system: string;
  prompt: string;
  tools: ToolSet;
  maxSteps: number;
  signal: AbortSignal;
  temperature?: number | null;
  maxOutputTokens?: number | null;
  timeoutMs?: number;
  onStepFinish?: (step: number) => void | Promise<void>;
  /** Injected for tests; defaults to the AI SDK's `generateText`. */
  generate?: GenerateTextFn;
}

const TOOLS_UNSUPPORTED =
  /does not support tools|tools? (use |calling )?(is |are )?not supported|unsupported.*tool/i;

function readUsage(
  u: UsageLike | undefined,
  prompt: string,
  text: string,
): AgentLoopUsage {
  const promptTokens =
    u?.inputTokens ?? u?.promptTokens ?? Math.ceil(prompt.length / 4);
  const completionTokens =
    u?.outputTokens ?? u?.completionTokens ?? Math.ceil(text.length / 4);
  return {
    promptTokens,
    completionTokens,
    totalTokens: u?.totalTokens ?? promptTokens + completionTokens,
  };
}

/**
 * Bounded tool loop. Hard-stops on `signal`: the model call is aborted via
 * `abortSignal`, in-flight tools are abandoned by the instrumentation, the
 * loop's stop condition checks the signal between steps, and the result is
 * discarded (AbortError thrown) if the signal fired at any point.
 */
export async function runKanbanAgentLoop(
  opts: AgentLoopOptions,
): Promise<AgentLoopResult> {
  const generate = opts.generate ?? (generateText as unknown as GenerateTextFn);
  const signal = opts.signal;
  if (signal.aborted) throw abortErrorFor(signal);

  const hasTools = Object.keys(opts.tools).length > 0;
  const maxSteps = Math.min(
    MAX_ALLOWED_STEPS,
    Math.max(1, Math.floor(opts.maxSteps)),
  );
  const callSignal = opts.timeoutMs
    ? AbortSignal.any([signal, AbortSignal.timeout(opts.timeoutMs)])
    : signal;
  let stepCount = 0;

  const call = (withTools: boolean) =>
    generate({
      model: opts.model,
      system: opts.system,
      prompt: opts.prompt,
      abortSignal: callSignal,
      maxRetries: 1,
      ...(opts.temperature !== null && opts.temperature !== undefined
        ? { temperature: opts.temperature }
        : {}),
      ...(opts.maxOutputTokens
        ? { maxOutputTokens: opts.maxOutputTokens }
        : {}),
      ...(withTools
        ? {
            tools: opts.tools,
            stopWhen: [stepCountIs(maxSteps), () => signal.aborted],
          }
        : {}),
      onStepFinish: async () => {
        stepCount++;
        try {
          await opts.onStepFinish?.(stepCount);
        } catch {
          // progress reporting is best-effort
        }
      },
    });

  let toolsDisabledReason: string | undefined;
  let result: Awaited<ReturnType<GenerateTextFn>>;
  try {
    result = await call(hasTools);
  } catch (err) {
    if (signal.aborted) throw abortErrorFor(signal);
    const msg = err instanceof Error ? err.message : String(err);
    if (hasTools && TOOLS_UNSUPPORTED.test(msg)) {
      // Many small local models can't do function calling. Run the task
      // anyway, without tools, and say so in the result.
      toolsDisabledReason = msg;
      logger.warn(`Model rejected tools, retrying without: ${msg}`);
      result = await call(false);
    } else {
      throw err;
    }
  }
  if (signal.aborted) throw abortErrorFor(signal);

  const text = result.text ?? "";
  return {
    content: text,
    steps: Array.isArray(result.steps)
      ? result.steps.length
      : Math.max(1, stepCount),
    usage: readUsage(result.totalUsage ?? result.usage, opts.prompt, text),
    ...(result.finishReason ? { finishReason: result.finishReason } : {}),
    ...(toolsDisabledReason ? { toolsDisabledReason } : {}),
  };
}

/** Tool-use guidance appended to the agent's own system prompt. */
export function buildAgenticSystemPrompt(
  base: string | null,
  toolNames: string[],
): string {
  const prompt = base?.trim() ? base.trim() : DEFAULT_KANBAN_SYSTEM_PROMPT;
  if (toolNames.length === 0) return prompt;
  return [
    prompt,
    "",
    "You are running unattended on a kanban task. You can call tools to inspect and act inside JoyCreate.",
    "Use tools only when they help complete the task; never invent tool results.",
    "Actions that send, delete, publish, deploy or spend money are not available to you. If the task needs one, describe exactly what should be done so a human can approve it.",
    "Finish with a concise summary of what you did and the result.",
  ].join("\n");
}
