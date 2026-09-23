import { describe, it, expect, vi, beforeEach } from "vitest";

const { getAgentMock, getDropMock, isProofGrantedMock } = vi.hoisted(() => ({
  getAgentMock: vi.fn(),
  getDropMock: vi.fn(),
  isProofGrantedMock: vi.fn(),
}));

vi.mock("@/lib/onchain/erc8004_client", () => ({
  getAgent: getAgentMock,
}));

vi.mock("@/lib/onchain/glue_client", () => ({
  getDrop: getDropMock,
  isProofGranted: isProofGrantedMock,
}));

import {
  parseSkillBundle,
  resolveSkill,
  assertRuntimeGate,
  executeSkill,
  invokeSkillRuntime,
  SKILL_BUNDLE_SCHEMA,
  MAX_INPUT_CHARS,
  MAX_TOOL_STEPS,
  MAX_CODE_TIMEOUT_MS,
  MAX_CODE_MEMORY_MB,
  type SkillBundle,
} from "@/lib/onchain/skill_runtime";

const CARD_CID = "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG";
const SKILL_CID = "QmXwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdH";

const VALID_SKILL: SkillBundle = {
  schema: SKILL_BUNDLE_SCHEMA,
  kind: "prompt-agent",
  modelId: "llama3",
  systemPrompt: "You are a helpful agent.",
  promptTemplate: "Answer: {{input}}",
};

const VALID_TOOL_SKILL: SkillBundle = {
  schema: SKILL_BUNDLE_SCHEMA,
  kind: "tool-agent",
  modelId: "llama3",
  systemPrompt: "You are a tool-using agent.",
  promptTemplate: "Task: {{input}}",
  tools: ["mcp__github__search_issues", "mcp__brave__web_search"],
  maxSteps: 4,
};

const VALID_CODE_SKILL: SkillBundle = {
  schema: SKILL_BUNDLE_SCHEMA,
  kind: "code-agent",
  code: "return input.toUpperCase();",
  allowedModules: ["node:crypto"],
  timeoutMs: 1000,
  maxMemoryMb: 64,
};

const VALID_CARD = {
  name: "store",
  version: "1.0",
  platform: "joycreate",
  type: "store",
  identity: { storeLabel: "store", owner: "0xabc" },
  chainId: 421614,
  modelConfig: null,
  systemPrompt: null,
  toolsSchema: null,
  skillCID: SKILL_CID,
};

const LICENSE_OK = { runtimeExecution: true } as const;

describe("parseSkillBundle", () => {
  it("accepts a valid bundle", () => {
    expect(parseSkillBundle(VALID_SKILL).modelId).toBe("llama3");
  });

  it("rejects a wrong schema", () => {
    expect(() => parseSkillBundle({ ...VALID_SKILL, schema: "x" })).toThrow(/unsupported skill schema/);
  });

  it("rejects a missing modelId", () => {
    expect(() => parseSkillBundle({ ...VALID_SKILL, modelId: "" })).toThrow(/modelId/);
  });

  it("rejects a non-object", () => {
    expect(() => parseSkillBundle(null)).toThrow(/not an object/);
  });

  it("accepts a valid tool-agent bundle", () => {
    const b = parseSkillBundle(VALID_TOOL_SKILL);
    expect(b.kind).toBe("tool-agent");
    if (b.kind === "tool-agent") {
      expect(b.tools).toEqual(["mcp__github__search_issues", "mcp__brave__web_search"]);
      expect(b.maxSteps).toBe(4);
    }
  });

  it("rejects a tool-agent with an empty allow-list", () => {
    expect(() => parseSkillBundle({ ...VALID_TOOL_SKILL, tools: [] })).toThrow(/non-empty tools/);
  });

  it("rejects a tool-agent with a malformed tool name", () => {
    expect(() => parseSkillBundle({ ...VALID_TOOL_SKILL, tools: ["not-a-tool"] })).toThrow(
      /invalid tool name/,
    );
  });

  it("clamps tool-agent maxSteps to the hard cap", () => {
    const b = parseSkillBundle({ ...VALID_TOOL_SKILL, maxSteps: 9999 });
    if (b.kind === "tool-agent") expect(b.maxSteps).toBe(MAX_TOOL_STEPS);
  });

  it("accepts a valid code-agent bundle", () => {
    const b = parseSkillBundle(VALID_CODE_SKILL);
    expect(b.kind).toBe("code-agent");
    if (b.kind === "code-agent") {
      expect(b.code).toContain("toUpperCase");
      expect(b.allowedModules).toEqual(["node:crypto"]);
    }
  });

  it("rejects a code-agent with empty code", () => {
    expect(() => parseSkillBundle({ ...VALID_CODE_SKILL, code: "   " })).toThrow(/non-empty code/);
  });

  it("rejects a code-agent with non-string allowedModules", () => {
    expect(() => parseSkillBundle({ ...VALID_CODE_SKILL, allowedModules: [1, 2] })).toThrow(
      /array of strings/,
    );
  });

  it("clamps code-agent timeout and memory to the hard caps", () => {
    const b = parseSkillBundle({ ...VALID_CODE_SKILL, timeoutMs: 999999, maxMemoryMb: 99999 });
    if (b.kind === "code-agent") {
      expect(b.timeoutMs).toBe(MAX_CODE_TIMEOUT_MS);
      expect(b.maxMemoryMb).toBe(MAX_CODE_MEMORY_MB);
    }
  });
});

describe("resolveSkill", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves identity → card → skill", async () => {
    getAgentMock.mockResolvedValue({ agentId: "1", agentDomain: `ipfs://${CARD_CID}`, agentAddress: "0xa" });
    const fetchJson = vi
      .fn()
      .mockResolvedValueOnce(VALID_CARD)
      .mockResolvedValueOnce(VALID_SKILL);
    const resolved = await resolveSkill("arbitrumSepolia", "1", { fetchJson });
    expect(resolved.cardCid).toBe(CARD_CID);
    expect(resolved.skillCid).toBe(SKILL_CID);
    expect(resolved.skill.modelId).toBe("llama3");
  });

  it("throws when agent has no card CID", async () => {
    getAgentMock.mockResolvedValue({ agentId: "1", agentDomain: "example.com", agentAddress: "0xa" });
    await expect(resolveSkill("arbitrumSepolia", "1", { fetchJson: vi.fn() })).rejects.toThrow(
      /no agent-card CID/,
    );
  });

  it("throws when card declares no skillCID", async () => {
    getAgentMock.mockResolvedValue({ agentId: "1", agentDomain: `ipfs://${CARD_CID}`, agentAddress: "0xa" });
    const fetchJson = vi.fn().mockResolvedValueOnce({ ...VALID_CARD, skillCID: null });
    await expect(resolveSkill("arbitrumSepolia", "1", { fetchJson })).rejects.toThrow(/no skillCID/);
  });
});

describe("assertRuntimeGate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws when license denies runtimeExecution", async () => {
    await expect(
      assertRuntimeGate({ chain: "arbitrumSepolia", license: { runtimeExecution: false } }),
    ).rejects.toThrow();
  });

  it("passes for a license-only gate (no drop)", async () => {
    const r = await assertRuntimeGate({ chain: "arbitrumSepolia", license: LICENSE_OK });
    expect(r.pouRequired).toBe(false);
  });

  it("skips PoU when drop does not require proof", async () => {
    getDropMock.mockResolvedValue({ requiresProof: false });
    const r = await assertRuntimeGate({
      chain: "arbitrumSepolia",
      license: LICENSE_OK,
      dropId: "5",
      buyer: "0xbuyer",
    });
    expect(r.pouRequired).toBe(false);
    expect(isProofGrantedMock).not.toHaveBeenCalled();
  });

  it("enforces PoU when drop requires proof", async () => {
    getDropMock.mockResolvedValue({ requiresProof: true });
    isProofGrantedMock.mockResolvedValue(false);
    await expect(
      assertRuntimeGate({
        chain: "arbitrumSepolia",
        license: LICENSE_OK,
        dropId: "5",
        buyer: "0xbuyer",
      }),
    ).rejects.toThrow(/Proof-of-Use not granted/);
  });

  it("requires a buyer when drop is PoU gated", async () => {
    getDropMock.mockResolvedValue({ requiresProof: true });
    await expect(
      assertRuntimeGate({ chain: "arbitrumSepolia", license: LICENSE_OK, dropId: "5" }),
    ).rejects.toThrow(/no buyer/);
  });

  it("passes when PoU is granted", async () => {
    getDropMock.mockResolvedValue({ requiresProof: true });
    isProofGrantedMock.mockResolvedValue(true);
    const r = await assertRuntimeGate({
      chain: "arbitrumSepolia",
      license: LICENSE_OK,
      dropId: "5",
      buyer: "0xbuyer",
    });
    expect(r.pouChecked).toBe(true);
  });
});

describe("executeSkill", () => {
  it("runs the injected inference fn with the templated prompt", async () => {
    const infer = vi.fn().mockResolvedValue({
      content: "42",
      finishReason: "stop",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    });
    const res = await executeSkill(VALID_SKILL, "what is the answer", { infer });
    expect(res.output).toBe("42");
    expect(res.modelId).toBe("llama3");
    expect(infer).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "Answer: what is the answer", systemPrompt: VALID_SKILL.systemPrompt }),
    );
  });

  it("rejects oversize input", async () => {
    await expect(
      executeSkill(VALID_SKILL, "x".repeat(MAX_INPUT_CHARS + 1), { infer: vi.fn() }),
    ).rejects.toThrow(/char cap/);
  });

  it("routes a tool-agent skill through the injected tool-calling loop", async () => {
    const toolAgent = vi.fn().mockResolvedValue({
      content: "found 3 issues",
      finishReason: "stop",
      steps: 3,
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    });
    const infer = vi.fn();
    const res = await executeSkill(VALID_TOOL_SKILL, "search bugs", { toolAgent, infer });
    expect(res.kind).toBe("tool-agent");
    expect(res.output).toBe("found 3 issues");
    expect(res.steps).toBe(3);
    // The prompt-agent inference path must NOT be used for a tool-agent.
    expect(infer).not.toHaveBeenCalled();
    expect(toolAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "Task: search bugs",
        tools: ["mcp__github__search_issues", "mcp__brave__web_search"],
        maxSteps: 4,
      }),
    );
  });

  it("routes a code-agent skill through the injected sandbox executor", async () => {
    const codeAgent = vi.fn().mockResolvedValue({ output: "HELLO", durationMs: 3 });
    const infer = vi.fn();
    const res = await executeSkill(VALID_CODE_SKILL, "hello", { codeAgent, infer });
    expect(res.kind).toBe("code-agent");
    expect(res.output).toBe("HELLO");
    expect(infer).not.toHaveBeenCalled();
    expect(codeAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "return input.toUpperCase();",
        input: "hello",
        allowedModules: ["node:crypto"],
      }),
    );
  });

  it("JSON-stringifies non-string code-agent output", async () => {
    const codeAgent = vi.fn().mockResolvedValue({ output: { ok: true } });
    const res = await executeSkill(VALID_CODE_SKILL, "x", { codeAgent });
    expect(res.output).toBe('{"ok":true}');
  });
});

describe("invokeSkillRuntime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("gates → resolves → executes end to end", async () => {
    getAgentMock.mockResolvedValue({ agentId: "1", agentDomain: `ipfs://${CARD_CID}`, agentAddress: "0xa" });
    getDropMock.mockResolvedValue({ requiresProof: true });
    isProofGrantedMock.mockResolvedValue(true);
    const fetchJson = vi.fn().mockResolvedValueOnce(VALID_CARD).mockResolvedValueOnce(VALID_SKILL);
    const infer = vi.fn().mockResolvedValue({ content: "done", finishReason: "stop" });
    const res = await invokeSkillRuntime(
      {
        chain: "arbitrumSepolia",
        agentId: "1",
        input: "go",
        license: LICENSE_OK,
        dropId: "5",
        buyer: "0xbuyer",
      },
      { fetchJson, infer },
    );
    expect(res.output).toBe("done");
    expect(res.skillCid).toBe(SKILL_CID);
  });

  it("refuses before any fetch when the license is denied", async () => {
    const fetchJson = vi.fn();
    await expect(
      invokeSkillRuntime(
        { chain: "arbitrumSepolia", agentId: "1", input: "go", license: { runtimeExecution: false } },
        { fetchJson, infer: vi.fn() },
      ),
    ).rejects.toThrow();
    expect(fetchJson).not.toHaveBeenCalled();
  });
});
