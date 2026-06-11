/**
 * LR8 / LR9 — local IPLD skill execution.
 *
 * Turns a purchased asset's pinned agent card into a *runnable* agent:
 *   identity (agentId) → agentDomain → agent-card CID → fetch card → skillCID →
 *   fetch + validate skill bundle → gate on license + Proof-of-Use → execute
 *   locally via the on-device model.
 *
 * Skill kinds:
 *   - `prompt-agent` (LR8): a single-shot declarative prompt + model manifest.
 *   - `tool-agent` (LR9): a multi-step tool-calling agent. The bundle declares
 *     an explicit allow-list of fully-qualified MCP tool names
 *     (`mcp__<server>__<tool>`) and a step cap; execution runs the AI SDK
 *     `generateText` agentic loop with only those tools exposed.
 *
 * Security posture (OWASP — untrusted code):
 *   - A skill bundle is a **declarative manifest** (model + system prompt +
 *     tools allow-list), NEVER executable code. We parse JSON, never
 *     `eval`/`require` it, so there is no remote-code-execution surface.
 *   - Execution is gated by the LR2 `runtimeExecution` license right AND the
 *     LR3 on-chain Proof-of-Use grant. Possessing the CID alone is never enough.
 *   - Tool-agent skills can ONLY reach the tools they explicitly allow-list, and
 *     every tool call still passes through the MCP consent layer
 *     (`buildMcpToolSet`). The bundle cannot widen its own permissions.
 *   - Inputs are length-capped; the assembled prompt only ever reaches the
 *     locally-configured model (no ambient credentials, no arbitrary network).
 *
 * Inference and tool-calling are injected (`RuntimeDeps`) so this module stays
 * unit-testable and does not pull the Electron-bound model manager or MCP hub
 * into the test graph.
 */

import log from "electron-log";

import type { GlueChainId } from "@/config/glue";
import type { Erc8004ChainId } from "@/config/erc8004";
import { agentDomainToCardCid, type AgentCard } from "@/lib/onchain/agent_card";
import { getAgent } from "@/lib/onchain/erc8004_client";
import { getDrop, isProofGranted } from "@/lib/onchain/glue_client";
import { checkLicense, normalizeLicense, type LicenseTerms } from "@/lib/onchain/license";
import { fetchIpfsJson } from "@/lib/ipfs/ipfs_fetch";

const logger = log.scope("skill_runtime");

export const SKILL_BUNDLE_SCHEMA = "joy-skill/1.0";

/** Hard caps for a single invocation (defence-in-depth). */
export const MAX_INPUT_CHARS = 32_000;
const MAX_OUTPUT_TOKENS = 2048;

/** Default and hard ceiling for a tool-agent's reasoning/tool-call loop. */
export const DEFAULT_TOOL_STEPS = 6;
export const MAX_TOOL_STEPS = 12;
/** Hard ceilings for a code-agent's sandboxed execution. */
export const MAX_CODE_TIMEOUT_MS = 30_000;
export const MAX_CODE_MEMORY_MB = 256;
/** Pattern every declared tool name must match (`mcp__<server>__<tool>`). */
const MCP_TOOL_NAME_RE = /^mcp__[a-z0-9_-]+__[a-z0-9_-]+$/i;

/** The schema field is common to every bundle, regardless of kind. */
interface SkillBundleCommon {
  schema: string;
}

/** Fields shared by model-backed skills (prompt-agent, tool-agent). */
interface ModelSkillFields {
  /** Model id understood by the local model manager (e.g. an Ollama tag). */
  modelId: string;
  systemPrompt: string;
  /** Optional user-prompt template; `{{input}}` is replaced with the input. */
  promptTemplate?: string;
  maxTokens?: number;
  temperature?: number;
}

/**
 * Single-shot declarative prompt agent (LR8). No tools, no code — the agent is
 * defined entirely by its model + system prompt.
 */
export interface PromptAgentBundle extends SkillBundleCommon, ModelSkillFields {
  kind: "prompt-agent";
}

/**
 * Multi-step tool-calling agent (LR9). Declares an explicit allow-list of
 * fully-qualified MCP tool names and a step cap; nothing outside `tools` is
 * ever exposed to the model.
 */
export interface ToolAgentBundle extends SkillBundleCommon, ModelSkillFields {
  kind: "tool-agent";
  /** Allow-list of fully-qualified MCP tool names (`mcp__<server>__<tool>`). */
  tools: string[];
  /** Max reasoning/tool-call steps. Clamped to `MAX_TOOL_STEPS`. */
  maxSteps?: number;
}

/**
 * Sandboxed code agent (LR10). Carries JavaScript source that is executed in a
 * hardened worker-thread sandbox — never `eval`/`require`d in the main process.
 * `require(...)` is denied for any module not in `allowedModules` (empty by
 * default). For *fully* untrusted marketplace code, run via the container path.
 */
export interface CodeAgentBundle extends SkillBundleCommon {
  kind: "code-agent";
  /** JavaScript source. Receives the runtime `input` string as its argument. */
  code: string;
  /** Modules the code may `require(...)`. Deny-all unless listed. */
  allowedModules?: string[];
  /** Execution timeout (ms). Clamped to `MAX_CODE_TIMEOUT_MS`. */
  timeoutMs?: number;
  /** Worker heap cap (MiB). Clamped to `MAX_CODE_MEMORY_MB`. */
  maxMemoryMb?: number;
}

/**
 * Declarative skill manifest fetched from `skillCID`. Prompt- and tool-agents
 * carry no executable code; a code-agent's source only ever runs in the
 * hardened sandbox.
 */
export type SkillBundle = PromptAgentBundle | ToolAgentBundle | CodeAgentBundle;

export interface ResolvedSkill {
  agentId: string;
  cardCid: string;
  skillCid: string;
  card: AgentCard;
  skill: SkillBundle;
}

export interface SkillExecutionResult {
  output: string;
  modelId: string;
  finishReason: string;
  /** Which kind of skill produced this result. */
  kind: SkillBundle["kind"];
  /** Number of agentic steps taken (tool-agent only; 1 for prompt-agent). */
  steps?: number;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
}

export interface RuntimeInvokeInput {
  chain: GlueChainId;
  agentId: string;
  input: string;
  /** License terms or SPDX string proving the `runtimeExecution` right. */
  license?: LicenseTerms | string | null;
  /** When the asset's drop is PoU-gated, the drop id + buyer to verify. */
  dropId?: string;
  buyer?: string;
}

/** Minimal inference contract — satisfied by `localModelManager.inference`. */
export type InferenceFn = (req: {
  modelId: string;
  prompt: string;
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
}) => Promise<{
  content: string;
  finishReason?: string;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
}>;

/**
 * Multi-step tool-calling contract (LR9). Runs the AI SDK agentic loop with
 * ONLY the allow-listed tools exposed. Injected so the MCP hub + model client
 * stay out of the unit-test graph.
 */
export type ToolAgentFn = (req: {
  modelId: string;
  prompt: string;
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
  /** Fully-qualified MCP tool names this run is allowed to call. */
  tools: string[];
  /** Hard step cap for the loop. */
  maxSteps: number;
}) => Promise<{
  content: string;
  finishReason?: string;
  steps?: number;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
}>;

export interface RuntimeDeps {
  fetchJson?: typeof fetchIpfsJson;
  infer?: InferenceFn;
  toolAgent?: ToolAgentFn;
  codeAgent?: CodeAgentFn;
}

/**
 * Sandboxed-code contract (LR10). Runs the bundle's JavaScript in a hardened
 * worker-thread isolate. Injected so the worker sandbox stays out of the unit
 * graph and tests can assert the gate without spawning threads.
 */
export type CodeAgentFn = (req: {
  code: string;
  input: string;
  allowedModules?: string[];
  timeoutMs?: number;
  maxMemoryMb?: number;
}) => Promise<{ output: unknown; durationMs?: number }>;

/** Lazily resolve the real on-device inference fn (keeps Electron out of tests). */
async function defaultInfer(): Promise<InferenceFn> {
  const { localModelManager } = await import("@/lib/local_model_manager");
  return async (req) => {
    const res = await localModelManager.inference({
      modelId: req.modelId,
      prompt: req.prompt,
      systemPrompt: req.systemPrompt,
      maxTokens: req.maxTokens,
      temperature: req.temperature,
    });
    return { content: res.content, finishReason: res.finishReason, usage: res.usage };
  };
}

/**
 * Lazily resolve the real tool-calling agent loop. Pulls the AI SDK, the MCP
 * bridge, the model client, and settings only when actually invoked — keeping
 * the Electron-bound graph out of unit tests (which inject `toolAgent`).
 */
async function defaultToolAgent(): Promise<ToolAgentFn> {
  const [{ generateText }, { buildMcpToolSet }, { getModelClient }, { readSettings }] =
    await Promise.all([
      import("ai"),
      import("@/lib/mcp_ai_bridge"),
      import("@/ipc/utils/get_model_client"),
      import("@/main/settings"),
    ]);
  return async (req) => {
    const settings = readSettings();
    const llm = {
      provider: "auto" as const,
      name: req.modelId,
    } as Parameters<typeof getModelClient>[0];
    const { modelClient } = await getModelClient(llm, settings);
    // Expose ONLY the allow-listed tools. Headless is allowed (trusted internal
    // caller); user-denied tools are still blocked inside the bridge.
    const { tools } = await buildMcpToolSet({
      allowHeadless: true,
      toolAllowList: req.tools,
    });
    const result = await generateText({
      model: modelClient.model,
      system: req.systemPrompt,
      prompt: req.prompt,
      maxOutputTokens: req.maxTokens,
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      tools,
      maxSteps: req.maxSteps,
    } as Parameters<typeof generateText>[0]);
    const r = result as {
      text?: string;
      finishReason?: string;
      steps?: unknown[];
      usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
    };
    return {
      content: r.text ?? "",
      finishReason: r.finishReason,
      steps: Array.isArray(r.steps) ? r.steps.length : undefined,
      usage: r.usage
        ? {
            promptTokens: r.usage.promptTokens ?? 0,
            completionTokens: r.usage.completionTokens ?? 0,
            totalTokens: r.usage.totalTokens ?? 0,
          }
        : undefined,
    };
  };
}

/**
 * Lazily resolve the real sandboxed-code executor. Routes through the hardened
 * worker-thread sandbox with a deny-all `require` allow-list by default.
 */
async function defaultCodeAgent(): Promise<CodeAgentFn> {
  const { runInSandbox } = await import("@/lib/sandbox/function_sandbox");
  return async (req) => {
    const res = await runInSandbox(req.code, req.input, {
      label: "code-agent",
      allowedModules: req.allowedModules,
      timeoutMs: req.timeoutMs,
      maxMemoryMb: req.maxMemoryMb,
    });
    if (!res.ok) {
      throw new Error(res.error ?? "sandboxed code execution failed");
    }
    return { output: res.output, durationMs: res.durationMs };
  };
}

/** Validate an untrusted JSON document as a SkillBundle. Throws on any mismatch. */
export function parseSkillBundle(raw: unknown): SkillBundle {
  if (!raw || typeof raw !== "object") throw new Error("skill bundle is not an object");
  const obj = raw as Record<string, unknown>;
  if (obj.schema !== SKILL_BUNDLE_SCHEMA) {
    throw new Error(`unsupported skill schema: ${String(obj.schema)} (expected ${SKILL_BUNDLE_SCHEMA})`);
  }
  if (obj.kind !== "prompt-agent" && obj.kind !== "tool-agent" && obj.kind !== "code-agent") {
    throw new Error(`unsupported skill kind: ${String(obj.kind)}`);
  }

  if (obj.kind === "code-agent") {
    if (typeof obj.code !== "string" || obj.code.trim().length === 0) {
      throw new Error("code-agent skill is missing a non-empty code string");
    }
    const bundle: CodeAgentBundle = {
      schema: SKILL_BUNDLE_SCHEMA,
      kind: "code-agent",
      code: obj.code,
    };
    if (obj.allowedModules !== undefined) {
      if (!Array.isArray(obj.allowedModules) || obj.allowedModules.some((m) => typeof m !== "string")) {
        throw new Error("code-agent allowedModules must be an array of strings");
      }
      bundle.allowedModules = obj.allowedModules as string[];
    }
    if (obj.timeoutMs !== undefined) {
      if (typeof obj.timeoutMs !== "number" || obj.timeoutMs < 1) {
        throw new Error("code-agent timeoutMs must be a positive number");
      }
      bundle.timeoutMs = Math.min(Math.floor(obj.timeoutMs), MAX_CODE_TIMEOUT_MS);
    }
    if (obj.maxMemoryMb !== undefined) {
      if (typeof obj.maxMemoryMb !== "number" || obj.maxMemoryMb < 1) {
        throw new Error("code-agent maxMemoryMb must be a positive number");
      }
      bundle.maxMemoryMb = Math.min(Math.floor(obj.maxMemoryMb), MAX_CODE_MEMORY_MB);
    }
    return bundle;
  }

  if (typeof obj.modelId !== "string" || obj.modelId.length === 0) {
    throw new Error("skill bundle is missing a modelId");
  }
  if (typeof obj.systemPrompt !== "string") {
    throw new Error("skill bundle is missing a systemPrompt");
  }

  if (obj.kind === "tool-agent") {
    if (!Array.isArray(obj.tools) || obj.tools.length === 0) {
      throw new Error("tool-agent skill must declare a non-empty tools allow-list");
    }
    const tools: string[] = [];
    for (const t of obj.tools) {
      if (typeof t !== "string" || !MCP_TOOL_NAME_RE.test(t)) {
        throw new Error(`invalid tool name in allow-list: ${String(t)} (expected mcp__<server>__<tool>)`);
      }
      tools.push(t);
    }
    if (obj.maxSteps !== undefined && (typeof obj.maxSteps !== "number" || obj.maxSteps < 1)) {
      throw new Error("tool-agent maxSteps must be a positive number");
    }
    const bundle: ToolAgentBundle = {
      schema: SKILL_BUNDLE_SCHEMA,
      kind: "tool-agent",
      modelId: obj.modelId,
      systemPrompt: obj.systemPrompt,
      tools,
    };
    if (typeof obj.promptTemplate === "string") bundle.promptTemplate = obj.promptTemplate;
    if (typeof obj.maxTokens === "number") bundle.maxTokens = obj.maxTokens;
    if (typeof obj.temperature === "number") bundle.temperature = obj.temperature;
    if (typeof obj.maxSteps === "number") {
      bundle.maxSteps = Math.min(Math.floor(obj.maxSteps), MAX_TOOL_STEPS);
    }
    return bundle;
  }

  const bundle: PromptAgentBundle = {
    schema: SKILL_BUNDLE_SCHEMA,
    kind: "prompt-agent",
    modelId: obj.modelId,
    systemPrompt: obj.systemPrompt,
  };
  if (typeof obj.promptTemplate === "string") bundle.promptTemplate = obj.promptTemplate;
  if (typeof obj.maxTokens === "number") bundle.maxTokens = obj.maxTokens;
  if (typeof obj.temperature === "number") bundle.temperature = obj.temperature;
  return bundle;
}

/**
 * Resolve an agent's runnable skill: identity → card CID → card → skillCID →
 * validated skill bundle. Throws if any link is missing or malformed.
 */
export async function resolveSkill(
  chain: GlueChainId,
  agentId: string,
  deps: RuntimeDeps = {},
): Promise<ResolvedSkill> {
  const fetchJson = deps.fetchJson ?? fetchIpfsJson;
  const agent = await getAgent(chain as Erc8004ChainId, agentId);
  const cardCid = agentDomainToCardCid(agent.agentDomain);
  if (!cardCid) {
    throw new Error(`agent ${agentId} has no agent-card CID (agentDomain="${agent.agentDomain}")`);
  }
  const card = await fetchJson<AgentCard>(cardCid);
  if (!card || typeof card !== "object" || !card.skillCID) {
    throw new Error(`agent card ${cardCid} declares no skillCID`);
  }
  const skillRaw = await fetchJson(card.skillCID);
  const skill = parseSkillBundle(skillRaw);
  return { agentId, cardCid, skillCid: card.skillCID, card, skill };
}

/**
 * Verify the caller may execute this asset's runtime. Throws when the license
 * does not grant `runtimeExecution`, or when the drop is PoU-gated and the
 * buyer holds no on-chain proof. Returns the resolved gate facts on success.
 */
export async function assertRuntimeGate(input: {
  chain: GlueChainId;
  license?: LicenseTerms | string | null;
  dropId?: string;
  buyer?: string;
}): Promise<{ pouChecked: boolean; pouRequired: boolean }> {
  const terms = normalizeLicense(input.license ?? undefined);
  const gate = checkLicense(terms, "runtimeExecution");
  if (!gate.allowed) {
    throw new Error(gate.reason ?? "license does not grant runtimeExecution");
  }

  if (!input.dropId) return { pouChecked: false, pouRequired: false };

  const drop = await getDrop(input.chain, input.dropId);
  if (!drop.requiresProof) return { pouChecked: false, pouRequired: false };

  if (!input.buyer) {
    throw new Error("drop is Proof-of-Use gated but no buyer address was provided");
  }
  const granted = await isProofGranted(input.chain, input.dropId, input.buyer);
  if (!granted) {
    throw new Error(`Proof-of-Use not granted for ${input.buyer} on drop ${input.dropId}`);
  }
  return { pouChecked: true, pouRequired: true };
}

/** Execute a validated skill bundle locally with a length-capped input. */
export async function executeSkill(
  skill: SkillBundle,
  userInput: string,
  deps: RuntimeDeps = {},
): Promise<SkillExecutionResult> {
  if (typeof userInput !== "string") throw new Error("input must be a string");
  if (userInput.length > MAX_INPUT_CHARS) {
    throw new Error(`input exceeds ${MAX_INPUT_CHARS} char cap`);
  }

  if (skill.kind === "code-agent") {
    const codeAgent = deps.codeAgent ?? (await defaultCodeAgent());
    const res = await codeAgent({
      code: skill.code,
      input: userInput,
      allowedModules: skill.allowedModules,
      timeoutMs: skill.timeoutMs,
      maxMemoryMb: skill.maxMemoryMb,
    });
    const output =
      typeof res.output === "string" ? res.output : JSON.stringify(res.output ?? null);
    return {
      output,
      modelId: "code-agent",
      finishReason: "stop",
      kind: "code-agent",
      steps: 1,
    };
  }

  const prompt = skill.promptTemplate
    ? skill.promptTemplate.replaceAll("{{input}}", userInput)
    : userInput;

  if (skill.kind === "tool-agent") {
    const toolAgent = deps.toolAgent ?? (await defaultToolAgent());
    const maxSteps = Math.min(skill.maxSteps ?? DEFAULT_TOOL_STEPS, MAX_TOOL_STEPS);
    const res = await toolAgent({
      modelId: skill.modelId,
      prompt,
      systemPrompt: skill.systemPrompt,
      maxTokens: skill.maxTokens ?? MAX_OUTPUT_TOKENS,
      temperature: skill.temperature,
      tools: skill.tools,
      maxSteps,
    });
    return {
      output: res.content,
      modelId: skill.modelId,
      finishReason: res.finishReason ?? "stop",
      kind: "tool-agent",
      steps: res.steps,
      usage: res.usage,
    };
  }

  const infer = deps.infer ?? (await defaultInfer());
  const res = await infer({
    modelId: skill.modelId,
    prompt,
    systemPrompt: skill.systemPrompt,
    maxTokens: skill.maxTokens ?? MAX_OUTPUT_TOKENS,
    temperature: skill.temperature,
  });
  return {
    output: res.content,
    modelId: skill.modelId,
    finishReason: res.finishReason ?? "stop",
    kind: "prompt-agent",
    steps: 1,
    usage: res.usage,
  };
}

/**
 * End-to-end: resolve → gate (license + PoU) → execute. This is the LR8 payoff
 * wired behind the `runtime_invoke` MCP tool.
 */
export async function invokeSkillRuntime(
  input: RuntimeInvokeInput,
  deps: RuntimeDeps = {},
): Promise<SkillExecutionResult & { agentId: string; skillCid: string }> {
  await assertRuntimeGate({
    chain: input.chain,
    license: input.license,
    dropId: input.dropId,
    buyer: input.buyer,
  });
  const resolved = await resolveSkill(input.chain, input.agentId, deps);
  logger.info(`executing skill ${resolved.skillCid} for agent ${input.agentId}`);
  const result = await executeSkill(resolved.skill, input.input, deps);
  return { ...result, agentId: input.agentId, skillCid: resolved.skillCid };
}
