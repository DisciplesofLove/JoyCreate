/**
 * BlueprintOrchestrator integration test.
 *
 * The orchestrator is exercised end-to-end with mocked persistence
 * (`run_store`) and mocked execution (`skill_engine`), so we can verify:
 *   - parse → resolve → verify → execute happy path
 *   - integrity-fail aborts the whole run BEFORE any node runs
 *   - per-node hash mismatch surfaces as BlueprintIntegrityError
 *   - template substitution forwards prior outputs to later nodes
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ResolvedSkill } from "@/lib/blueprint/skill_resolver";

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

// In-memory run_store
const runs = new Map<string, any>();
const nodeStateLog: Array<{ runId: string; nodeId: string; status: string }> = [];

vi.mock("@/lib/blueprint/run_store", () => ({
  createRun: vi.fn(async (args: any) => {
    runs.set(args.id, { ...args, nodeState: {}, status: "pending" });
    return runs.get(args.id);
  }),
  updateRunStatus: vi.fn(async (id: string, status: string, extra: any = {}) => {
    const r = runs.get(id);
    if (r) Object.assign(r, { status, ...extra });
  }),
  updateNodeState: vi.fn(async (id: string, nodeId: string, state: any) => {
    const r = runs.get(id);
    if (r) {
      r.nodeState[nodeId] = state;
      nodeStateLog.push({ runId: id, nodeId, status: state.status });
    }
  }),
  getRun: vi.fn(async (id: string) => runs.get(id) ?? null),
  listRuns: vi.fn(async () => Array.from(runs.values())),
  listResumableRuns: vi.fn(async () => []),
}));

const skillCalls: Array<{ skillId: number; input: string }> = [];
vi.mock("@/lib/skill_engine", () => ({
  executeSkill: vi.fn(async ({ skillId, input }: { skillId: number; input: string }) => {
    skillCalls.push({ skillId, input });
    return { success: true, output: `result-${skillId}`, duration: 1 };
  }),
}));

// Programmable resolver
const resolverMap = new Map<string, ResolvedSkill>();
vi.mock("@/lib/blueprint/skill_resolver", async () => {
  const actual = await vi.importActual<typeof import("@/lib/blueprint/skill_resolver")>(
    "@/lib/blueprint/skill_resolver",
  );
  return {
    ...actual,
    resolveSkill: vi.fn(async (name: string) => {
      const v = resolverMap.get(name);
      if (!v) throw new Error(`unmapped skill in test: ${name}`);
      return v;
    }),
  };
});

// Imports AFTER mocks are registered
import { BlueprintOrchestrator } from "@/lib/blueprint/orchestrator";
import { computeIntentHash } from "@/lib/blueprint/intent_hash";
import { BlueprintIntegrityError } from "@/types/blueprint_types";

function makeSkill(id: number, name: string, code = "return 1;"): ResolvedSkill {
  return {
    kind: "skill_engine",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    skill: {
      id,
      name,
      description: "",
      category: "general",
      version: "1.0.0",
      type: "function",
      implementationType: "javascript",
      implementationCode: code,
      inputSchema: {},
      outputSchema: {},
      enabled: true,
    } as any,
  };
}

beforeEach(() => {
  runs.clear();
  nodeStateLog.length = 0;
  skillCalls.length = 0;
  resolverMap.clear();
});

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("BlueprintOrchestrator — happy path", () => {
  it("runs a 2-node DAG end-to-end", async () => {
    const skillA = makeSkill(1, "alpha");
    const skillB = makeSkill(2, "beta");
    resolverMap.set("alpha", skillA);
    resolverMap.set("beta", skillB);
    const hashA = computeIntentHash(skillA);
    const hashB = computeIntentHash(skillB);

    const yaml = `
id: bp-happy
version: "1.0.0"
author_did: did:joy:alice
nodes:
  - id: a
    skill: alpha
    params: { input: "hi" }
    verify_intent: ${hashA}
  - id: b
    skill: beta
    params: { input: "{{a.output}}" }
    verify_intent: ${hashB}
`;
    const orch = new BlueprintOrchestrator();
    const runId = await orch.run({ yamlText: yaml });

    await waitFor(() => runs.get(runId)?.status === "succeeded");
    const r = runs.get(runId);
    expect(r.status).toBe("succeeded");
    expect(r.nodeState.a.status).toBe("succeeded");
    expect(r.nodeState.b.status).toBe("succeeded");
    expect(skillCalls).toHaveLength(2);
    // node b's input should have been substituted from a's output
    expect(skillCalls[1].input).toContain("result-1");
  });
});

describe("BlueprintOrchestrator — integrity", () => {
  it("aborts BEFORE executing when verify_intent does not match", async () => {
    const skillA = makeSkill(1, "alpha");
    resolverMap.set("alpha", skillA);
    const yaml = `
id: bp-bad
version: "1"
author_did: did:joy:x
nodes:
  - id: a
    skill: alpha
    params: {}
    verify_intent: ${"f".repeat(64)}
`;
    const orch = new BlueprintOrchestrator();
    await expect(orch.run({ yamlText: yaml })).rejects.toBeInstanceOf(
      BlueprintIntegrityError,
    );
    expect(skillCalls).toHaveLength(0);
    // No run should have been created
    expect(runs.size).toBe(0);
  });
});

describe("BlueprintOrchestrator — dryRun", () => {
  it("skips execution but records the run", async () => {
    const skillA = makeSkill(1, "alpha");
    resolverMap.set("alpha", skillA);
    const hash = computeIntentHash(skillA);
    const yaml = `
id: bp-dry
version: "1"
author_did: did:joy:x
nodes:
  - id: a
    skill: alpha
    params: {}
    verify_intent: ${hash}
`;
    const orch = new BlueprintOrchestrator();
    const runId = await orch.run({ yamlText: yaml, dryRun: true });
    await waitFor(() => runs.get(runId)?.status === "succeeded");
    expect(skillCalls).toHaveLength(0);
    expect(runs.get(runId).status).toBe("succeeded");
  });
});
