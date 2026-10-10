import { describe, it, expect, vi } from "vitest";
import { tool, type ToolSet } from "ai";
import { z } from "zod";

vi.mock("electron-log", () => ({
  default: {
    scope: () => ({
      log: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
    }),
  },
}));

vi.mock("electron", () => ({}));

// assembleKanbanToolSet imports the bridge for planMcpAllowList; stub its
// heavy dependencies (DB + hub manager) so only the pure helper runs.
vi.mock("../db", () => ({ db: {} }));
vi.mock("../db/schema", () => ({ mcpServers: {} }));
vi.mock("../ipc/utils/mcp_hub_manager", () => ({ mcpHubManager: {} }));
vi.mock("../ipc/utils/mcp_consent", () => ({
  getStoredConsent: vi.fn(),
  requireMcpToolConsent: vi.fn(),
}));

import {
  agentRowToKanbanConfig,
  assembleKanbanToolSet,
  buildOpenClawActionTools,
  classifyOpenClawAction,
  instrumentToolSet,
  loadKanbanAgentConfig,
  normalizeAgentTemperature,
  resolveKanbanLanguageModel,
  runKanbanAgentLoop,
  shouldRunAgentic,
  toolNameForAction,
  type GenerateTextFn,
  type KanbanToolTraceEntry,
} from "../lib/kanban_agent_runtime";
import type { ActionDefinition } from "../types/openclaw_autonomous_types";

function action(id: string, category = id.split(".")[0]): ActionDefinition {
  return {
    id,
    category: category as ActionDefinition["category"],
    name: id,
    description: `desc ${id}`,
    parameters: [],
    channel: `chan:${id}`,
  };
}

const dbRow = {
  id: 7,
  name: "Research Bot",
  systemPrompt: "You are a research bot.",
  modelId: "claude-sonnet-5",
  temperature: 70,
  maxTokens: 2048,
  configJson: {
    mcpToolsAllow: ["mcp__brave__search"],
    tools: { enabled: [], customTools: [], mcpServers: ["3", "x"] },
    custom: { kanban: { maxSteps: 4, allowWriteActions: false } },
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Agent config loading
// ─────────────────────────────────────────────────────────────────────────────

describe("normalizeAgentTemperature", () => {
  it("scales the 0-100 integer column to 0-1", () => {
    expect(normalizeAgentTemperature(70)).toBeCloseTo(0.7);
    expect(normalizeAgentTemperature(100)).toBe(1);
  });
  it("passes small already-unscaled values through", () => {
    expect(normalizeAgentTemperature(0.3)).toBeCloseTo(0.3);
    expect(normalizeAgentTemperature(0)).toBe(0);
  });
  it("returns null for missing / invalid values", () => {
    expect(normalizeAgentTemperature(null)).toBeNull();
    expect(normalizeAgentTemperature(undefined)).toBeNull();
    expect(normalizeAgentTemperature("abc")).toBeNull();
    expect(normalizeAgentTemperature(-5)).toBeNull();
  });
});

describe("loadKanbanAgentConfig", () => {
  it("loads numeric ids from the SQLite agents table", async () => {
    const loadDbAgent = vi.fn().mockResolvedValue(dbRow);
    const readJsonFile = vi.fn();
    const cfg = await loadKanbanAgentConfig("7", { loadDbAgent, readJsonFile });
    expect(loadDbAgent).toHaveBeenCalledWith(7);
    expect(readJsonFile).not.toHaveBeenCalled();
    expect(cfg).toMatchObject({
      source: "db",
      agentId: "7",
      name: "Research Bot",
      systemPrompt: "You are a research bot.",
      modelId: "claude-sonnet-5",
      maxTokens: 2048,
      mcpToolsAllow: ["mcp__brave__search"],
      mcpServerIds: [3],
      kanban: { tools: true, maxSteps: 4, allowWriteActions: false },
    });
    expect(cfg?.temperature).toBeCloseTo(0.7);
  });

  it("falls back to the agent_builder JSON store for non-numeric ids", async () => {
    const readJsonFile = vi.fn(async (p: string) =>
      p === "agents.json"
        ? [
            {
              id: "abc-123",
              name: "Store Agent",
              config: {
                model: "llama3.2:3b",
                temperature: 0.2,
                maxTokens: 512,
              },
              prompts: { system: "store prompt" },
            },
          ]
        : null,
    );
    const cfg = await loadKanbanAgentConfig("abc-123", {
      loadDbAgent: vi.fn(),
      readJsonFile,
    });
    expect(cfg).toMatchObject({
      source: "agent_store",
      name: "Store Agent",
      systemPrompt: "store prompt",
      modelId: "llama3.2:3b",
      maxTokens: 512,
    });
    expect(cfg?.temperature).toBeCloseTo(0.2);
  });

  it("falls back to the legacy per-agent file", async () => {
    const readJsonFile = vi.fn(async (p: string) =>
      p === "legacy1.json"
        ? { name: "Legacy", systemPrompt: "legacy prompt" }
        : null,
    );
    const cfg = await loadKanbanAgentConfig("legacy1", { readJsonFile });
    expect(cfg).toMatchObject({
      source: "legacy_file",
      name: "Legacy",
      systemPrompt: "legacy prompt",
    });
  });

  it("falls through to files when a numeric id is missing from the DB", async () => {
    const readJsonFile = vi.fn(async (p: string) =>
      p === "42.json" ? { name: "File 42", systemPrompt: "p" } : null,
    );
    const cfg = await loadKanbanAgentConfig(42, {
      loadDbAgent: vi.fn().mockResolvedValue(null),
      readJsonFile,
    });
    expect(cfg?.source).toBe("legacy_file");
  });

  it("refuses path-traversal ids and returns null for unknown agents", async () => {
    const readJsonFile = vi.fn().mockResolvedValue(null);
    expect(
      await loadKanbanAgentConfig("../../etc/passwd", { readJsonFile }),
    ).toBeNull();
    expect(readJsonFile).not.toHaveBeenCalled();
    expect(await loadKanbanAgentConfig("nope", { readJsonFile })).toBeNull();
    expect(await loadKanbanAgentConfig(null)).toBeNull();
    expect(await loadKanbanAgentConfig("  ")).toBeNull();
  });
});

describe("shouldRunAgentic", () => {
  const cfg = agentRowToKanbanConfig({ ...dbRow, configJson: null });
  it("runs agentic when an agent is assigned", () => {
    expect(shouldRunAgentic({ taskType: "custom" }, cfg)).toBe(true);
  });
  it("honours an agent opting out of tools", () => {
    const off = agentRowToKanbanConfig({
      ...dbRow,
      configJson: { custom: { kanban: { tools: false } } },
    });
    expect(shouldRunAgentic({ taskType: "agent_task" }, off)).toBe(false);
  });
  it("keeps the plain path for agent-less tasks unless type is agent_task", () => {
    expect(shouldRunAgentic({ taskType: "research" }, null)).toBe(false);
    expect(shouldRunAgentic({ taskType: "agent_task" }, null)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Model resolution (cloud routing)
// ─────────────────────────────────────────────────────────────────────────────

describe("resolveKanbanLanguageModel", () => {
  const catalog = {
    anthropic: [{ name: "claude-sonnet-5" }],
    auto: [{ name: "claude-sonnet-5" }],
    openai: [{ name: "gpt-5.6-luna" }],
  };
  it("routes catalog models to their cloud provider even if the registry said ollama", () => {
    const r = resolveKanbanLanguageModel(
      "claude-sonnet-5",
      "ollama",
      catalog,
      null,
    );
    expect(r).toEqual({
      model: { provider: "anthropic", name: "claude-sonnet-5" },
      providerLabel: "anthropic",
      local: false,
    });
  });
  it("prefers the user's selected provider when it also serves the model", () => {
    const r = resolveKanbanLanguageModel("claude-sonnet-5", "cloud", catalog, {
      provider: "auto",
      name: "x",
    });
    expect(r.model.provider).toBe("auto");
  });
  it("keeps ollama tags local", () => {
    const r = resolveKanbanLanguageModel(
      "llama3.2:3b",
      "ollama",
      catalog,
      null,
    );
    expect(r).toMatchObject({ providerLabel: "ollama", local: true });
  });
  it("sends unknown cloud selections to the selected cloud model, not Ollama", () => {
    const r = resolveKanbanLanguageModel("mystery-model", "cloud", catalog, {
      provider: "openai",
      name: "gpt-5.6-luna",
    });
    expect(r.model).toEqual({ provider: "openai", name: "gpt-5.6-luna" });
    expect(r.local).toBe(false);
  });
  it("supports explicit provider/model ids", () => {
    expect(
      resolveKanbanLanguageModel("openai/gpt-x", "ollama", catalog).model,
    ).toEqual({
      provider: "openai",
      name: "gpt-x",
    });
    expect(
      resolveKanbanLanguageModel("ollama/qwen3", "cloud", catalog)
        .providerLabel,
    ).toBe("ollama");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tool-set assembly + destructive filtering
// ─────────────────────────────────────────────────────────────────────────────

describe("classifyOpenClawAction", () => {
  it.each([
    ["email.send", "destructive"],
    ["document.delete", "destructive"],
    ["skill.publish", "destructive"],
    ["github.create_repo", "destructive"],
    ["secrets.get", "destructive"],
    ["secrets.list", "destructive"],
    ["services.stop_all", "destructive"],
    ["system.n8n_start", "destructive"],
    ["model.download", "destructive"],
    ["workflow.execute", "destructive"],
    ["cicd.run_pipeline", "destructive"],
    ["agent_trigger.create", "destructive"],
    ["marketplace.install", "destructive"],
    ["app.list", "read"],
    ["app.get", "read"],
    ["document.read_content", "read"],
    ["system.ollama_status", "read"],
    ["blockchain.tokens", "read"],
    ["document.create", "write"],
    ["image.generate", "write"],
  ])("%s → %s", (id, risk) => {
    expect(classifyOpenClawAction(action(id))).toBe(risk);
  });

  it("never classifies a dangerous-looking real catalog action as read/write", async () => {
    const { ACTION_CATALOG } = await import("../lib/openclaw_actions");
    expect(ACTION_CATALOG.length).toBeGreaterThan(50);
    const dangerous =
      /send|delete|publish|deploy|secret|push|install|download|transfer|purchase/;
    // Read-only lookups such as `deploy.check_completeness` or
    // `blockchain.purchases` are fine; a *write* with one of these words is not.
    const leaked = ACTION_CATALOG.filter(
      (a) => dangerous.test(a.id) && classifyOpenClawAction(a) === "write",
    ).map((a) => a.id);
    expect(leaked).toEqual([]);
    if (process.env.KANBAN_PRINT_CLASSIFICATION) {
      const by: Record<string, string[]> = {
        read: [],
        write: [],
        destructive: [],
      };
      for (const a of ACTION_CATALOG) by[classifyOpenClawAction(a)].push(a.id);
      console.log(JSON.stringify(by));
    }
  });

  it("classifies known-dangerous ids as destructive", async () => {
    const ids = [
      "email.send",
      "deploy.auto_deploy",
      "agent.publish",
      "agent.deploy",
      "services.start_all",
      "secrets.create",
      "workflow.delete",
      "workflow.activate",
      "orchestrator.cancel",
      "swarm.start",
      "mission.start",
    ];
    for (const id of ids)
      expect(classifyOpenClawAction(action(id))).toBe("destructive");
  });
});

describe("buildOpenClawActionTools", () => {
  const catalog = [
    action("app.list"),
    action("document.create"),
    action("email.send"),
    action("secrets.get"),
  ];
  const dispatch = vi.fn(
    async (id: string, params: Record<string, unknown>) => ({ id, params }),
  );

  it("never exposes destructive actions and reports them as blocked", () => {
    const r = buildOpenClawActionTools({ catalog, dispatch });
    expect(r.exposed.sort()).toEqual(
      [
        toolNameForAction("app.list"),
        toolNameForAction("document.create"),
      ].sort(),
    );
    expect(r.blocked.map((b) => b.actionId).sort()).toEqual([
      "email.send",
      "secrets.get",
    ]);
    expect(Object.keys(r.tools)).not.toContain(toolNameForAction("email.send"));
  });

  it("an explicit allow-list cannot opt a destructive action in", () => {
    const r = buildOpenClawActionTools({
      catalog,
      dispatch,
      allowList: ["email.send", "app.list"],
    });
    expect(r.exposed).toEqual([toolNameForAction("app.list")]);
    expect(r.blocked.map((b) => b.actionId)).toEqual(["email.send"]);
  });

  it("drops write actions when the agent disables them", () => {
    const r = buildOpenClawActionTools({
      catalog,
      dispatch,
      allowWriteActions: false,
    });
    expect(r.exposed).toEqual([toolNameForAction("app.list")]);
  });

  it("dispatches through dispatchAction with the action id", async () => {
    const r = buildOpenClawActionTools({
      catalog: [action("app.list")],
      dispatch,
    });
    const t = r.tools[toolNameForAction("app.list")];
    await t.execute?.({}, { toolCallId: "1", messages: [] });
    expect(dispatch).toHaveBeenCalledWith("app.list", {});
  });

  it("produces AI-SDK-safe tool names", () => {
    expect(toolNameForAction("agent_builder.list")).toBe(
      "openclaw__agent_builder__list",
    );
    expect(toolNameForAction("agent_builder.list")).toMatch(/^[a-zA-Z0-9_-]+$/);
  });
});

describe("assembleKanbanToolSet", () => {
  const catalog = [action("app.list"), action("email.send")];

  it("merges MCP + OpenClaw tools, passes headless + agent scoping to the MCP bridge", async () => {
    const buildMcpToolSet = vi.fn().mockResolvedValue({
      tools: {
        mcp__brave__search: tool({
          description: "search",
          inputSchema: z.object({ q: z.string() }),
          execute: async () => "results",
        }),
      },
      summary: { totalTools: 1 },
    });
    const agent = agentRowToKanbanConfig(dbRow);
    const r = await assembleKanbanToolSet(
      agent,
      { signal: new AbortController().signal },
      { buildMcpToolSet, catalog, dispatch: vi.fn() },
    );
    expect(buildMcpToolSet).toHaveBeenCalledWith({
      allowHeadless: true,
      serverIds: [3],
      toolAllowList: ["mcp__brave__search"],
    });
    expect(Object.keys(r.tools).sort()).toEqual(
      ["mcp__brave__search", toolNameForAction("app.list")].sort(),
    );
    expect(r.blockedActions.map((b) => b.actionId)).toEqual(["email.send"]);
  });

  it("skips MCP entirely when the agent's allow-list is empty", async () => {
    const buildMcpToolSet = vi.fn();
    const agent = agentRowToKanbanConfig({
      ...dbRow,
      configJson: { mcpToolsAllow: [] },
    });
    const r = await assembleKanbanToolSet(
      agent,
      { signal: new AbortController().signal },
      { buildMcpToolSet, catalog, dispatch: vi.fn() },
    );
    expect(buildMcpToolSet).not.toHaveBeenCalled();
    expect(r.mcpToolNames).toEqual([]);
  });

  it("survives an MCP bridge failure", async () => {
    const r = await assembleKanbanToolSet(
      null,
      { signal: new AbortController().signal },
      {
        buildMcpToolSet: vi.fn().mockRejectedValue(new Error("hub down")),
        catalog,
        dispatch: vi.fn(),
      },
    );
    expect(r.mcpError).toBe("hub down");
    expect(r.actionToolNames).toEqual([toolNameForAction("app.list")]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tracing + abort mid-loop
// ─────────────────────────────────────────────────────────────────────────────

function fakeTools(calls: string[]): ToolSet {
  return {
    first: tool({
      description: "first",
      inputSchema: z.object({}),
      execute: async () => {
        calls.push("first");
        return { ok: 1 };
      },
    }),
    second: tool({
      description: "second",
      inputSchema: z.object({}),
      execute: async () => {
        calls.push("second");
        return "two";
      },
    }),
    slow: tool({
      description: "slow",
      inputSchema: z.object({}),
      execute: (): Promise<string> =>
        new Promise<string>((resolve) => {
          calls.push("slow-start");
          setTimeout(() => resolve("late"), 10_000);
        }),
    }),
  };
}

const opts = { toolCallId: "t", messages: [] };

describe("instrumentToolSet", () => {
  it("records ok and error calls in the trace and via the hook", async () => {
    const trace: KanbanToolTraceEntry[] = [];
    const onToolCall = vi.fn();
    const tools = instrumentToolSet(
      {
        good: tool({
          description: "",
          inputSchema: z.object({}),
          execute: async () => "fine",
        }),
        bad: tool({
          description: "",
          inputSchema: z.object({}),
          execute: async (): Promise<string> => {
            throw new Error("boom");
          },
        }),
      },
      {
        signal: new AbortController().signal,
        sourceOf: () => "openclaw",
        trace,
        onToolCall,
      },
    );
    await tools.good.execute?.({ a: 1 }, opts);
    await expect(tools.bad.execute?.({}, opts)).rejects.toThrow("boom");
    expect(trace.map((t) => [t.toolName, t.status])).toEqual([
      ["good", "ok"],
      ["bad", "error"],
    ]);
    expect(trace[0].argsPreview).toBe('{"a":1}');
    expect(onToolCall).toHaveBeenCalledTimes(2);
  });

  it("truncates huge outputs before they reach the model", async () => {
    const tools = instrumentToolSet(
      {
        big: tool({
          description: "",
          inputSchema: z.object({}),
          execute: async () => "x".repeat(20_000),
        }),
      },
      { signal: new AbortController().signal, sourceOf: () => "mcp" },
    );
    const out = (await tools.big.execute?.({}, opts)) as string;
    expect(out.length).toBeLessThan(7000);
    expect(out).toContain("output truncated");
  });
});

describe("runKanbanAgentLoop abort", () => {
  it("hard-stops mid-loop: later tools never run and the run rejects", async () => {
    const calls: string[] = [];
    const controller = new AbortController();
    const trace: KanbanToolTraceEntry[] = [];
    const tools = instrumentToolSet(fakeTools(calls), {
      signal: controller.signal,
      sourceOf: () => "openclaw",
      trace,
    });

    // Fake model loop: step 1 calls "first", then the user hits Stop, then
    // the model tries to call "second".
    const generate: GenerateTextFn = async (args) => {
      const ts = args.tools as ToolSet;
      await ts.first.execute?.({}, opts);
      controller.abort("Hard-stopped by user");
      try {
        await ts.second.execute?.({}, opts);
      } catch {
        // the SDK would turn this into a tool error and keep going
      }
      return { text: "should be discarded", steps: [{}, {}] };
    };

    await expect(
      runKanbanAgentLoop({
        model: {},
        system: "s",
        prompt: "p",
        tools,
        maxSteps: 5,
        signal: controller.signal,
        generate,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(calls).toEqual(["first"]);
    expect(trace.map((t) => [t.toolName, t.status])).toEqual([
      ["first", "ok"],
      ["second", "aborted"],
    ]);
  });

  it("abandons an in-flight tool the moment the task is aborted", async () => {
    const calls: string[] = [];
    const controller = new AbortController();
    const tools = instrumentToolSet(fakeTools(calls), {
      signal: controller.signal,
      sourceOf: () => "mcp",
    });
    const pending = tools.slow.execute?.({}, opts) as Promise<unknown>;
    setTimeout(() => controller.abort(), 5);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toEqual(["slow-start"]);
  });

  it("passes the stop condition, abort signal and step bound to generateText", async () => {
    const controller = new AbortController();
    const generate = vi.fn<GenerateTextFn>(async (args) => {
      await (args.onStepFinish as () => Promise<void>)();
      return {
        text: "done",
        steps: [{}],
        totalUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        finishReason: "stop",
      };
    });
    const onStepFinish = vi.fn();
    const r = await runKanbanAgentLoop({
      model: {},
      system: "s",
      prompt: "p",
      tools: fakeTools([]),
      maxSteps: 99,
      signal: controller.signal,
      generate,
      onStepFinish,
    });
    expect(r).toMatchObject({
      content: "done",
      steps: 1,
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    });
    const args = generate.mock.calls[0][0];
    expect(args.abortSignal).toBe(controller.signal);
    expect(Array.isArray(args.stopWhen)).toBe(true);
    expect(onStepFinish).toHaveBeenCalledWith(1);
  });

  it("refuses to start when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const generate = vi.fn();
    await expect(
      runKanbanAgentLoop({
        model: {},
        system: "s",
        prompt: "p",
        tools: {},
        maxSteps: 3,
        signal: controller.signal,
        generate,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(generate).not.toHaveBeenCalled();
  });

  it("retries without tools when the model can't do function calling", async () => {
    const generate = vi
      .fn<GenerateTextFn>()
      .mockRejectedValueOnce(
        new Error("registry.ollama.ai/library/gemma does not support tools"),
      )
      .mockResolvedValueOnce({ text: "plain answer" });
    const r = await runKanbanAgentLoop({
      model: {},
      system: "s",
      prompt: "p",
      tools: fakeTools([]),
      maxSteps: 3,
      signal: new AbortController().signal,
      generate,
    });
    expect(r.content).toBe("plain answer");
    expect(r.toolsDisabledReason).toMatch(/does not support tools/);
    expect(generate.mock.calls[1][0].tools).toBeUndefined();
  });
});
