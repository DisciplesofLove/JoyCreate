/**
 * Unit tests for {@link FederatedAggregator}.
 *
 * Every external dependency (peer feed, ACL gate, byte fetcher, applier)
 * is faked in-memory so we can deterministically verify scoring,
 * filtering, deny-by-default ACL, weighted merge math, and graceful
 * skip-on-error behaviour.
 */

import { describe, expect, it, vi } from "vitest";

import {
  FederatedAggregator,
  weightedAverage,
  weightFor,
  type AggregationCandidate,
  type AggregatorDeps,
} from "@/lib/genius_core/federated_aggregator";

function cand(
  id: string,
  overrides: Partial<AggregationCandidate> = {},
): AggregationCandidate {
  return {
    adapterId: id,
    peerPubkey: `peer-${id}`,
    baseModelId: "phi-3-mini-4k-instruct-int4-onnx",
    sampleCount: 100,
    finalLoss: 1.0,
    ts: 0,
    ...overrides,
  };
}

function makeDeps(over: Partial<AggregatorDeps> = {}): AggregatorDeps & {
  bytesByAdapter: Map<string, Float32Array>;
  applyCalls: Array<{ projectId: string; merged: Float32Array; sources: AggregationCandidate[] }>;
  publishCalls: Array<Record<string, unknown>>;
} {
  const bytesByAdapter = new Map<string, Float32Array>();
  const applyCalls: Array<{
    projectId: string;
    merged: Float32Array;
    sources: AggregationCandidate[];
  }> = [];
  const publishCalls: Array<Record<string, unknown>> = [];
  const base: AggregatorDeps = {
    readPeerCandidates: vi.fn(async () => []),
    aclGate: vi.fn(async () => true),
    fetchAdapterWeights: vi.fn(async (c) => {
      const b = bytesByAdapter.get(c.adapterId);
      if (!b) throw new Error(`no bytes for ${c.adapterId}`);
      return b;
    }),
    applyMergedAdapter: vi.fn(async (args) => {
      applyCalls.push(args);
      return { newSlotCid: `bafkre-${applyCalls.length}` };
    }),
    publishAggregated: vi.fn(async (p) => {
      publishCalls.push(p);
    }),
    ...over,
  };
  return Object.assign(base, { bytesByAdapter, applyCalls, publishCalls });
}

// ──────────────────────────────────────────────────────────────────────
// Pure helpers
// ──────────────────────────────────────────────────────────────────────

describe("weightFor", () => {
  it("scales linearly with sample count and inversely with loss", () => {
    expect(weightFor(cand("a", { sampleCount: 100, finalLoss: 1 }))).toBe(100);
    expect(weightFor(cand("a", { sampleCount: 100, finalLoss: 2 }))).toBe(50);
    expect(weightFor(cand("a", { sampleCount: 200, finalLoss: 1 }))).toBe(200);
  });

  it("clamps zero loss to 0.01 to avoid divide-by-zero", () => {
    expect(weightFor(cand("a", { sampleCount: 1, finalLoss: 0 }))).toBe(100);
  });

  it("clamps negative sample count to zero", () => {
    expect(weightFor(cand("a", { sampleCount: -5, finalLoss: 1 }))).toBe(0);
  });
});

describe("weightedAverage", () => {
  it("computes a correct weighted average over equal-length arrays", () => {
    const a = new Float32Array([1, 2, 3]);
    const b = new Float32Array([3, 4, 5]);
    const out = weightedAverage([a, b], [1, 3]);
    // expected = (1*[1,2,3] + 3*[3,4,5]) / 4 = [2.5, 3.5, 4.5]
    expect(Array.from(out)).toEqual([2.5, 3.5, 4.5]);
  });

  it("throws on empty input", () => {
    expect(() => weightedAverage([], [])).toThrow(/no arrays/);
  });

  it("throws on length mismatch", () => {
    const a = new Float32Array([1, 2]);
    const b = new Float32Array([1, 2, 3]);
    expect(() => weightedAverage([a, b], [1, 1])).toThrow(/length/);
  });

  it("throws on non-positive total weight", () => {
    const a = new Float32Array([1, 2]);
    expect(() => weightedAverage([a], [0])).toThrow(/totalWeight/);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Aggregator behaviour
// ──────────────────────────────────────────────────────────────────────

describe("FederatedAggregator", () => {
  it("validates constructor options", () => {
    const deps = makeDeps();
    expect(() => new FederatedAggregator(deps, { topK: 0 })).toThrow();
    expect(() => new FederatedAggregator(deps, { minSampleCount: -1 })).toThrow();
    expect(() => new FederatedAggregator(deps, { maxLoss: 0 })).toThrow();
  });

  it("requires projectId on run()", async () => {
    const agg = new FederatedAggregator(makeDeps());
    await expect(agg.run({ projectId: "" })).rejects.toThrow(/projectId/);
  });

  it("returns merged:false when no peers report anything", async () => {
    const deps = makeDeps({ readPeerCandidates: vi.fn(async () => []) });
    const agg = new FederatedAggregator(deps);
    const res = await agg.run({ projectId: "p1" });
    expect(res.merged).toBe(false);
    expect(res.candidatesRead).toBe(0);
    expect(deps.applyMergedAdapter).not.toHaveBeenCalled();
  });

  it("filters out under-sampled candidates", async () => {
    const deps = makeDeps({
      readPeerCandidates: vi.fn(async () => [
        cand("a", { sampleCount: 5 }),
        cand("b", { sampleCount: 8 }),
      ]),
    });
    const agg = new FederatedAggregator(deps, { minSampleCount: 16 });
    const res = await agg.run({ projectId: "p1" });
    expect(res.merged).toBe(false);
    expect(res.candidatesRead).toBe(2);
    expect(res.candidatesUsed).toBe(0);
  });

  it("filters out high-loss candidates", async () => {
    const deps = makeDeps({
      readPeerCandidates: vi.fn(async () => [
        cand("a", { finalLoss: 10 }),
        cand("b", { finalLoss: Number.NaN }),
      ]),
    });
    const agg = new FederatedAggregator(deps, { maxLoss: 5 });
    const res = await agg.run({ projectId: "p1" });
    expect(res.merged).toBe(false);
  });

  it("filters out mismatched base model", async () => {
    const deps = makeDeps({
      readPeerCandidates: vi.fn(async () => [
        cand("a", { baseModelId: "other-base" }),
      ]),
    });
    const agg = new FederatedAggregator(deps, {
      baseModelId: "phi-3-mini-4k-instruct-int4-onnx",
    });
    const res = await agg.run({ projectId: "p1" });
    expect(res.merged).toBe(false);
  });

  it("denies by default when aclGate returns false", async () => {
    const deps = makeDeps({
      readPeerCandidates: vi.fn(async () => [cand("a"), cand("b")]),
      aclGate: vi.fn(async () => false),
    });
    deps.bytesByAdapter.set("a", new Float32Array([1, 2, 3]));
    deps.bytesByAdapter.set("b", new Float32Array([1, 2, 3]));
    const agg = new FederatedAggregator(deps);
    const res = await agg.run({ projectId: "p1" });
    expect(res.merged).toBe(false);
    expect(res.candidatesUsed).toBe(0);
  });

  it("treats aclGate throws as deny (skips candidate)", async () => {
    const deps = makeDeps({
      readPeerCandidates: vi.fn(async () => [cand("a"), cand("b")]),
      aclGate: vi.fn(async (c) => {
        if (c.adapterId === "a") throw new Error("boom");
        return true;
      }),
    });
    deps.bytesByAdapter.set("a", new Float32Array([1, 2, 3]));
    deps.bytesByAdapter.set("b", new Float32Array([4, 5, 6]));
    const agg = new FederatedAggregator(deps);
    const res = await agg.run({ projectId: "p1" });
    // "a" denied, "b" approved → merged from b alone.
    expect(res.merged).toBe(true);
    expect(res.candidatesUsed).toBe(1);
    expect(res.sourceAdapterIds).toEqual(["b"]);
  });

  it("merges weighted average across multiple approved candidates", async () => {
    const deps = makeDeps({
      readPeerCandidates: vi.fn(async () => [
        cand("a", { sampleCount: 100, finalLoss: 1 }), // weight 100
        cand("b", { sampleCount: 100, finalLoss: 4 }), // weight 25
      ]),
    });
    deps.bytesByAdapter.set("a", new Float32Array([10, 20]));
    deps.bytesByAdapter.set("b", new Float32Array([0, 0]));
    const agg = new FederatedAggregator(deps);
    const res = await agg.run({ projectId: "p1" });
    expect(res.merged).toBe(true);
    expect(res.candidatesUsed).toBe(2);
    expect(res.totalWeight).toBe(125);
    // merged = (100*[10,20] + 25*[0,0]) / 125 = [8, 16]
    const merged = deps.applyCalls[0].merged;
    expect(Array.from(merged)).toEqual([8, 16]);
  });

  it("respects topK ordering by descending weight", async () => {
    const deps = makeDeps({
      readPeerCandidates: vi.fn(async () => [
        cand("low", { sampleCount: 50, finalLoss: 5 }), // w = 10
        cand("hi", { sampleCount: 200, finalLoss: 1 }), // w = 200
        cand("mid", { sampleCount: 100, finalLoss: 2 }), // w = 50
      ]),
    });
    deps.bytesByAdapter.set("low", new Float32Array([1]));
    deps.bytesByAdapter.set("hi", new Float32Array([1]));
    deps.bytesByAdapter.set("mid", new Float32Array([1]));
    const agg = new FederatedAggregator(deps, { topK: 2 });
    const res = await agg.run({ projectId: "p1" });
    expect(res.sourceAdapterIds).toEqual(["hi", "mid"]);
  });

  it("skips candidates whose byte fetch fails", async () => {
    const deps = makeDeps({
      readPeerCandidates: vi.fn(async () => [cand("a"), cand("b")]),
    });
    // "a" is missing from the byte store → fetchAdapterWeights throws.
    deps.bytesByAdapter.set("b", new Float32Array([1, 2]));
    const agg = new FederatedAggregator(deps);
    const res = await agg.run({ projectId: "p1" });
    expect(res.merged).toBe(true);
    expect(res.sourceAdapterIds).toEqual(["b"]);
  });

  it("skips candidates whose adapter shape mismatches the first", async () => {
    const deps = makeDeps({
      readPeerCandidates: vi.fn(async () => [
        cand("a", { sampleCount: 200, finalLoss: 1 }), // ranked first
        cand("b", { sampleCount: 100, finalLoss: 1 }),
      ]),
    });
    deps.bytesByAdapter.set("a", new Float32Array([1, 2, 3]));
    deps.bytesByAdapter.set("b", new Float32Array([1, 2])); // wrong shape
    const agg = new FederatedAggregator(deps);
    const res = await agg.run({ projectId: "p1" });
    expect(res.merged).toBe(true);
    expect(res.sourceAdapterIds).toEqual(["a"]);
  });

  it("publishes the aggregated event on success", async () => {
    const deps = makeDeps({
      readPeerCandidates: vi.fn(async () => [cand("a")]),
    });
    deps.bytesByAdapter.set("a", new Float32Array([1, 2]));
    const agg = new FederatedAggregator(deps);
    const res = await agg.run({ projectId: "p1" });
    expect(res.merged).toBe(true);
    expect(deps.publishCalls).toHaveLength(1);
    expect(deps.publishCalls[0]).toMatchObject({
      projectId: "p1",
      candidatesUsed: 1,
      sourceAdapterIds: ["a"],
      newSlotCid: "bafkre-1",
    });
  });

  it("swallows publishAggregated errors", async () => {
    const deps = makeDeps({
      readPeerCandidates: vi.fn(async () => [cand("a")]),
      publishAggregated: vi.fn(async () => {
        throw new Error("bus down");
      }),
    });
    deps.bytesByAdapter.set("a", new Float32Array([1, 2]));
    const agg = new FederatedAggregator(deps);
    const res = await agg.run({ projectId: "p1" });
    expect(res.merged).toBe(true);
  });
});
