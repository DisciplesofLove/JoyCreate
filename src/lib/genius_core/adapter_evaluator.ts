/**
 * Genius Core — adapter quality scoring + auto-rollback.
 *
 * Runs a small, project-specific eval set against the currently loaded
 * adapter and produces a deterministic score in [0, 1]. Used by the
 * distillation scheduler to decide whether a freshly trained adapter is
 * good enough to keep — or should be auto-rolled-back to the previous
 * context slot.
 *
 * Scoring is intentionally **model-agnostic and dependency-free** for v1:
 * each prompt is paired with a list of expected keywords; a response
 * scores 1 if any keyword appears (case-insensitive), 0 otherwise. Mean
 * across all prompts is the final score. Later phases can swap in
 * embedding similarity or a judge-LLM scorer behind the same interface.
 *
 * Runtime-agnostic: every dependency (inference function, DB handle,
 * clock) is injected so the evaluator is unit-testable without ONNX,
 * SQLite, or Helia.
 */

import log from "electron-log";

const logger = log.scope("genius_core.adapter_evaluator");

// ── Public types ────────────────────────────────────────────────────────

export interface EvalSet {
  projectId: number;
  prompts: string[];
  /** Parallel to `prompts`; each entry holds keywords that count as a pass. */
  expectedKeywords: string[][];
  lastScore: number | null;
  lastEvaluatedAtMs: number | null;
}

export interface AdapterScoreRow {
  projectId: number;
  adapterId: string;
  slotCid: string | null;
  score: number;
  sampleCount: number;
  outcome: "applied" | "rolled_back" | "rejected";
  baselineScore: number | null;
  evaluatedAtMs: number;
}

export interface AdapterEvaluationResult {
  score: number;
  sampleCount: number;
  baselineScore: number | null;
  /**
   * True when `(baselineScore - score) >= rollbackThreshold` and
   * `baselineScore !== null`. Caller decides whether to actually act.
   */
  regression: boolean;
}

// ── Injectable dependencies ─────────────────────────────────────────────

/** Inference seam — typically `(prompt) => GeniusCore.infer({prompt}).then(r => r.text)`. */
export type EvalInferFn = (prompt: string) => Promise<string>;

/** Persistence surface for eval sets + score history. */
export interface AdapterScoreStore {
  readEvalSet(projectId: number): Promise<EvalSet | null>;
  writeEvalSet(
    projectId: number,
    prompts: string[],
    expectedKeywords: string[][],
  ): Promise<void>;
  updateLastScore(
    projectId: number,
    score: number,
    evaluatedAtMs: number,
  ): Promise<void>;
  appendScore(row: AdapterScoreRow): Promise<void>;
  listScores(projectId: number, limit: number): Promise<AdapterScoreRow[]>;
  /** Most recent `outcome === "applied"` row, used as the regression baseline. */
  latestAppliedScore(projectId: number): Promise<AdapterScoreRow | null>;
}

export interface AdapterEvaluatorOptions {
  infer: EvalInferFn;
  store: AdapterScoreStore;
  now?: () => number;
  /** Maximum prompts per eval set; over-cap writes throw. Default 32. */
  maxPrompts?: number;
}

// ── Pure scoring helper (exported for tests) ────────────────────────────

/**
 * Score a single response against its expected keyword set.
 * Returns 1 if any keyword is present (case-insensitive substring),
 * 0 otherwise. An empty keyword list scores 0 — caller should validate
 * upstream rather than silently passing.
 */
export function scoreResponse(
  response: string,
  expectedKeywords: string[],
): 0 | 1 {
  if (!response || expectedKeywords.length === 0) return 0;
  const haystack = response.toLowerCase();
  for (const keyword of expectedKeywords) {
    if (keyword && haystack.includes(keyword.toLowerCase())) return 1;
  }
  return 0;
}

// ── Evaluator ───────────────────────────────────────────────────────────

const DEFAULT_MAX_PROMPTS = 32;

export class AdapterEvaluator {
  private readonly infer: EvalInferFn;
  private readonly store: AdapterScoreStore;
  private readonly now: () => number;
  private readonly maxPrompts: number;

  constructor(opts: AdapterEvaluatorOptions) {
    if (typeof opts.infer !== "function") {
      throw new Error("AdapterEvaluator requires an infer function");
    }
    if (!opts.store) throw new Error("AdapterEvaluator requires a store");
    this.infer = opts.infer;
    this.store = opts.store;
    this.now = opts.now ?? (() => Date.now());
    this.maxPrompts = opts.maxPrompts ?? DEFAULT_MAX_PROMPTS;
  }

  async getEvalSet(projectId: number): Promise<EvalSet | null> {
    this.assertProjectId(projectId);
    return this.store.readEvalSet(projectId);
  }

  async setEvalSet(
    projectId: number,
    prompts: string[],
    expectedKeywords: string[][],
  ): Promise<void> {
    this.assertProjectId(projectId);
    if (!Array.isArray(prompts) || prompts.length === 0) {
      throw new Error("eval set requires at least one prompt");
    }
    if (prompts.length > this.maxPrompts) {
      throw new Error(
        `eval set capped at ${this.maxPrompts} prompts (got ${prompts.length})`,
      );
    }
    if (!Array.isArray(expectedKeywords) || expectedKeywords.length !== prompts.length) {
      throw new Error(
        "expectedKeywords must be a parallel array matching prompts.length",
      );
    }
    for (let i = 0; i < prompts.length; i += 1) {
      if (typeof prompts[i] !== "string" || prompts[i].length === 0) {
        throw new Error(`prompt[${i}] must be a non-empty string`);
      }
      const kws = expectedKeywords[i];
      if (!Array.isArray(kws) || kws.length === 0) {
        throw new Error(`expectedKeywords[${i}] must be a non-empty array`);
      }
      for (const kw of kws) {
        if (typeof kw !== "string" || kw.length === 0) {
          throw new Error(`expectedKeywords[${i}] contains a non-string entry`);
        }
      }
    }
    await this.store.writeEvalSet(projectId, prompts, expectedKeywords);
  }

  /**
   * Run the project's eval set against the currently active adapter and
   * persist a score row + lastScore. Returns `{regression, score, ...}`.
   *
   * Caller is expected to ensure the right context slot is already loaded
   * via `GeniusCore.loadContextSlot(...)` before invoking — the evaluator
   * does NOT swap adapters itself.
   *
   * `rollbackThreshold` is the absolute drop (in [0, 1] units) that
   * triggers `regression: true`. Pass 0 to disable.
   */
  async evaluate(args: {
    projectId: number;
    adapterId: string;
    slotCid: string | null;
    rollbackThreshold: number;
  }): Promise<AdapterEvaluationResult | null> {
    this.assertProjectId(args.projectId);
    if (!args.adapterId) throw new Error("adapterId is required");

    const set = await this.store.readEvalSet(args.projectId);
    if (!set || set.prompts.length === 0) {
      // No eval set configured — skip scoring, never block distillation.
      return null;
    }

    const baseline = await this.store.latestAppliedScore(args.projectId);

    let total = 0;
    let counted = 0;
    for (let i = 0; i < set.prompts.length; i += 1) {
      let response = "";
      try {
        response = await this.infer(set.prompts[i]);
      } catch (err) {
        // Skip prompts that fail to infer rather than poisoning the score.
        logger.warn(`eval prompt ${i} infer failed (skipped)`, err);
        continue;
      }
      total += scoreResponse(response, set.expectedKeywords[i]);
      counted += 1;
    }
    if (counted === 0) {
      logger.warn("eval skipped: all prompts failed to infer", {
        projectId: args.projectId,
      });
      return null;
    }

    const score = total / counted;
    const evaluatedAtMs = this.now();
    const baselineScore = baseline?.score ?? null;
    const regression =
      baselineScore !== null &&
      rollbackThreshold(args.rollbackThreshold) > 0 &&
      baselineScore - score >= rollbackThreshold(args.rollbackThreshold);

    await this.store.appendScore({
      projectId: args.projectId,
      adapterId: args.adapterId,
      slotCid: args.slotCid,
      score,
      sampleCount: counted,
      outcome: regression ? "rolled_back" : "applied",
      baselineScore,
      evaluatedAtMs,
    });
    await this.store.updateLastScore(args.projectId, score, evaluatedAtMs);

    logger.info("adapter evaluated", {
      projectId: args.projectId,
      adapterId: args.adapterId,
      score: Number(score.toFixed(4)),
      baseline: baselineScore,
      regression,
    });
    return { score, sampleCount: counted, baselineScore, regression };
  }

  async listScores(
    projectId: number,
    limit = 50,
  ): Promise<AdapterScoreRow[]> {
    this.assertProjectId(projectId);
    return this.store.listScores(projectId, Math.max(1, Math.min(500, limit)));
  }

  private assertProjectId(projectId: number): void {
    if (!Number.isInteger(projectId) || projectId <= 0) {
      throw new Error("projectId must be a positive integer");
    }
  }
}

function rollbackThreshold(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

// ── Production wiring ───────────────────────────────────────────────────

let liveEvaluator: AdapterEvaluator | null = null;

/**
 * Reset the singleton — exported for tests + settings-toggle teardown.
 */
export function resetAdapterEvaluator(): void {
  liveEvaluator = null;
}

export function getAdapterEvaluator(): AdapterEvaluator {
  if (!liveEvaluator) {
    throw new Error(
      "AdapterEvaluator not set up — call setupAdapterEvaluator() first",
    );
  }
  return liveEvaluator;
}

/**
 * Lazy initialiser binding the evaluator against the live Drizzle store +
 * the active GeniusCore inference path. Idempotent.
 */
export async function setupAdapterEvaluator(): Promise<AdapterEvaluator> {
  if (liveEvaluator) return liveEvaluator;

  const [{ db }, schemaModule, { GeniusCore }] = await Promise.all([
    import("@/db"),
    import("@/db/schema"),
    import("@/lib/genius_core"),
  ]);
  const { geniusCoreEvalSets, geniusCoreAdapterScores } =
    schemaModule as unknown as {
      geniusCoreEvalSets: typeof import("@/db/schema").geniusCoreEvalSets;
      geniusCoreAdapterScores: typeof import("@/db/schema").geniusCoreAdapterScores;
    };
  const { eq, desc } = await import("drizzle-orm");

  const store: AdapterScoreStore = {
    async readEvalSet(projectId) {
      const row = await db
        .select()
        .from(geniusCoreEvalSets)
        .where(eq(geniusCoreEvalSets.projectId, projectId))
        .limit(1);
      const r = row[0];
      if (!r) return null;
      return {
        projectId: r.projectId,
        prompts: r.prompts,
        expectedKeywords: r.expectedKeywords,
        lastScore: r.lastScore,
        lastEvaluatedAtMs: r.lastEvaluatedAt
          ? r.lastEvaluatedAt.getTime()
          : null,
      };
    },
    async writeEvalSet(projectId, prompts, expectedKeywords) {
      await db
        .insert(geniusCoreEvalSets)
        .values({ projectId, prompts, expectedKeywords })
        .onConflictDoUpdate({
          target: geniusCoreEvalSets.projectId,
          set: {
            prompts,
            expectedKeywords,
            updatedAt: new Date(),
          },
        });
    },
    async updateLastScore(projectId, score, evaluatedAtMs) {
      await db
        .update(geniusCoreEvalSets)
        .set({
          lastScore: score,
          lastEvaluatedAt: new Date(evaluatedAtMs),
          updatedAt: new Date(),
        })
        .where(eq(geniusCoreEvalSets.projectId, projectId));
    },
    async appendScore(row) {
      await db.insert(geniusCoreAdapterScores).values({
        projectId: row.projectId,
        adapterId: row.adapterId,
        slotCid: row.slotCid,
        score: row.score,
        sampleCount: row.sampleCount,
        outcome: row.outcome,
        baselineScore: row.baselineScore,
        evaluatedAt: new Date(row.evaluatedAtMs),
      });
    },
    async listScores(projectId, limit) {
      const rows = await db
        .select()
        .from(geniusCoreAdapterScores)
        .where(eq(geniusCoreAdapterScores.projectId, projectId))
        .orderBy(desc(geniusCoreAdapterScores.evaluatedAt))
        .limit(limit);
      return rows.map((r) => ({
        projectId: r.projectId,
        adapterId: r.adapterId,
        slotCid: r.slotCid,
        score: r.score,
        sampleCount: r.sampleCount,
        outcome: r.outcome as AdapterScoreRow["outcome"],
        baselineScore: r.baselineScore,
        evaluatedAtMs: r.evaluatedAt.getTime(),
      }));
    },
    async latestAppliedScore(projectId) {
      const rows = await db
        .select()
        .from(geniusCoreAdapterScores)
        .where(eq(geniusCoreAdapterScores.projectId, projectId))
        .orderBy(desc(geniusCoreAdapterScores.evaluatedAt))
        .limit(20);
      const applied = rows.find((r) => r.outcome === "applied");
      if (!applied) return null;
      return {
        projectId: applied.projectId,
        adapterId: applied.adapterId,
        slotCid: applied.slotCid,
        score: applied.score,
        sampleCount: applied.sampleCount,
        outcome: "applied",
        baselineScore: applied.baselineScore,
        evaluatedAtMs: applied.evaluatedAt.getTime(),
      };
    },
  };

  liveEvaluator = new AdapterEvaluator({
    store,
    infer: async (prompt: string) => {
      const res = await GeniusCore.infer({ prompt, maxTokens: 128 });
      return res.text;
    },
  });
  return liveEvaluator;
}
