/**
 * Unit tests for the adapter quality evaluator. Exercises the pure
 * scoring helper plus the AdapterEvaluator class against an in-memory
 * fake store + inject-able infer fn (no ONNX, no SQLite).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  AdapterEvaluator,
  scoreResponse,
  type AdapterScoreRow,
  type AdapterScoreStore,
  type EvalSet,
} from "@/lib/genius_core/adapter_evaluator";

function createFakeStore(): AdapterScoreStore & {
  __evalSets: Map<number, EvalSet>;
  __scores: AdapterScoreRow[];
} {
  const evalSets = new Map<number, EvalSet>();
  const scores: AdapterScoreRow[] = [];
  return {
    __evalSets: evalSets,
    __scores: scores,
    async readEvalSet(projectId) {
      return evalSets.get(projectId) ?? null;
    },
    async writeEvalSet(projectId, prompts, expectedKeywords) {
      evalSets.set(projectId, {
        projectId,
        prompts,
        expectedKeywords,
        lastScore: null,
        lastEvaluatedAtMs: null,
      });
    },
    async updateLastScore(projectId, score, evaluatedAtMs) {
      const set = evalSets.get(projectId);
      if (!set) return;
      evalSets.set(projectId, {
        ...set,
        lastScore: score,
        lastEvaluatedAtMs: evaluatedAtMs,
      });
    },
    async appendScore(row) {
      scores.push(row);
    },
    async listScores(projectId, limit) {
      return scores
        .filter((s) => s.projectId === projectId)
        .slice(-limit)
        .reverse();
    },
    async latestAppliedScore(projectId) {
      for (let i = scores.length - 1; i >= 0; i -= 1) {
        if (scores[i].projectId === projectId && scores[i].outcome === "applied") {
          return scores[i];
        }
      }
      return null;
    },
  };
}

describe("scoreResponse", () => {
  it("returns 1 when any keyword matches case-insensitively", () => {
    expect(scoreResponse("The Quick Brown Fox", ["fox"])).toBe(1);
    expect(scoreResponse("hello world", ["foo", "world"])).toBe(1);
  });
  it("returns 0 when nothing matches", () => {
    expect(scoreResponse("nothing here", ["alpha", "beta"])).toBe(0);
  });
  it("returns 0 on empty inputs", () => {
    expect(scoreResponse("", ["x"])).toBe(0);
    expect(scoreResponse("anything", [])).toBe(0);
  });
});

describe("AdapterEvaluator", () => {
  let store: ReturnType<typeof createFakeStore>;
  let clock: { now: number };

  beforeEach(() => {
    store = createFakeStore();
    clock = { now: 1_700_000_000_000 };
  });

  function makeEvaluator(infer: (prompt: string) => Promise<string>) {
    return new AdapterEvaluator({
      store,
      infer,
      now: () => clock.now,
    });
  }

  it("rejects invalid project ids and empty eval sets", async () => {
    const evaluator = makeEvaluator(async () => "ok");
    await expect(evaluator.setEvalSet(0, ["p"], [["k"]])).rejects.toThrow(
      /projectId/i,
    );
    await expect(evaluator.setEvalSet(1, [], [])).rejects.toThrow(
      /at least one prompt/,
    );
    await expect(
      evaluator.setEvalSet(1, ["a", "b"], [["k"]]),
    ).rejects.toThrow(/parallel array/);
    await expect(
      evaluator.setEvalSet(1, ["a"], [[]]),
    ).rejects.toThrow(/non-empty array/);
  });

  it("returns null when no eval set is configured", async () => {
    const evaluator = makeEvaluator(async () => "anything");
    const result = await evaluator.evaluate({
      projectId: 7,
      adapterId: "adapter-a",
      slotCid: null,
      rollbackThreshold: 0.05,
    });
    expect(result).toBeNull();
  });

  it("scores responses and records an applied row on first run (no baseline)", async () => {
    const evaluator = makeEvaluator(async (prompt) =>
      prompt === "what is 2+2" ? "the answer is 4" : "I don't know",
    );
    await evaluator.setEvalSet(
      42,
      ["what is 2+2", "name a fruit"],
      [["4", "four"], ["apple", "banana", "fruit"]],
    );

    const result = await evaluator.evaluate({
      projectId: 42,
      adapterId: "adapter-1",
      slotCid: "bafkrei-slot-1",
      rollbackThreshold: 0.05,
    });

    expect(result).not.toBeNull();
    expect(result!.score).toBe(0.5); // first prompt matches, second doesn't
    expect(result!.baselineScore).toBeNull();
    expect(result!.regression).toBe(false);
    expect(store.__scores).toHaveLength(1);
    expect(store.__scores[0].outcome).toBe("applied");
    expect(store.__scores[0].slotCid).toBe("bafkrei-slot-1");
    expect(store.__evalSets.get(42)?.lastScore).toBe(0.5);
  });

  it("flags a regression when score drops below baseline by threshold", async () => {
    // Seed a baseline applied row at score 1.0.
    store.__scores.push({
      projectId: 11,
      adapterId: "old",
      slotCid: "cid-old",
      score: 1.0,
      sampleCount: 2,
      outcome: "applied",
      baselineScore: null,
      evaluatedAtMs: clock.now - 1000,
    });

    const evaluator = makeEvaluator(async () => "wrong answer");
    await evaluator.setEvalSet(11, ["q1", "q2"], [["right"], ["right"]]);

    const result = await evaluator.evaluate({
      projectId: 11,
      adapterId: "new",
      slotCid: "cid-new",
      rollbackThreshold: 0.05,
    });
    expect(result!.score).toBe(0);
    expect(result!.baselineScore).toBe(1.0);
    expect(result!.regression).toBe(true);
    const lastRow = store.__scores[store.__scores.length - 1];
    expect(lastRow.outcome).toBe("rolled_back");
    expect(lastRow.baselineScore).toBe(1.0);
  });

  it("does NOT flag regression when threshold is 0", async () => {
    store.__scores.push({
      projectId: 12,
      adapterId: "old",
      slotCid: null,
      score: 1.0,
      sampleCount: 1,
      outcome: "applied",
      baselineScore: null,
      evaluatedAtMs: clock.now - 1000,
    });
    const evaluator = makeEvaluator(async () => "no match");
    await evaluator.setEvalSet(12, ["q"], [["yes"]]);
    const result = await evaluator.evaluate({
      projectId: 12,
      adapterId: "new",
      slotCid: null,
      rollbackThreshold: 0,
    });
    expect(result!.regression).toBe(false);
    expect(store.__scores[store.__scores.length - 1].outcome).toBe("applied");
  });

  it("skips failed-infer prompts but still scores remaining ones", async () => {
    let calls = 0;
    const infer = vi.fn(async (_prompt: string) => {
      calls += 1;
      if (calls === 1) throw new Error("boom");
      return "match";
    });
    const evaluator = makeEvaluator(infer);
    await evaluator.setEvalSet(
      3,
      ["a", "b"],
      [["never"], ["match"]],
    );
    const result = await evaluator.evaluate({
      projectId: 3,
      adapterId: "x",
      slotCid: null,
      rollbackThreshold: 0.05,
    });
    expect(result!.sampleCount).toBe(1);
    expect(result!.score).toBe(1);
  });

  it("returns null when every prompt fails to infer", async () => {
    const evaluator = makeEvaluator(async () => {
      throw new Error("offline");
    });
    await evaluator.setEvalSet(4, ["p"], [["k"]]);
    const result = await evaluator.evaluate({
      projectId: 4,
      adapterId: "a",
      slotCid: null,
      rollbackThreshold: 0.05,
    });
    expect(result).toBeNull();
    expect(store.__scores).toHaveLength(0);
  });
});
