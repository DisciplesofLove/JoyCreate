/**
 * A LoRA or QLoRA run takes hours, and both training implementations kept the
 * job in a module-level `Map`. Two consequences, both proven here:
 *
 *   - closing the app did not fail a run, it erased it. The record, the epoch
 *     it reached and the pointer to the half-written adapter all went with the
 *     process.
 *   - on success the job object was mutated in memory and nothing was inserted
 *     into `model_registry_entries`. "Trained models" reads that table, so the
 *     adapter the user waited hours for was invisible to the whole app — it
 *     could not be listed, used, merged or published.
 */

import { describe, expect, it, beforeEach, vi } from "vitest";

const { tables, activities } = vi.hoisted(() => ({
  tables: {
    training_jobs: [] as any[],
    model_registry_entries: [] as any[],
  } as Record<string, any[]>,
  activities: [] as Array<{ id: string; event: string; detail?: unknown }>,
}));

vi.mock("electron-log", () => ({
  default: {
    scope: () => ({
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    }),
  },
}));

vi.mock("drizzle-orm", () => {
  type P = (r: any) => boolean;
  return {
    eq: (c: any, v: any): P => (r) => r[c] === v,
    and:
      (...ps: P[]): P =>
      (r) => ps.every((p) => !p || p(r)),
    desc: (c: any) => c,
    inArray: (c: any, vals: any[]): P => (r) => vals.includes(r[c]),
    sql: Object.assign(() => undefined, { raw: () => undefined }),
  };
});

vi.mock("@/db/training_schema", () => ({
  trainingJobs: {
    __t: "training_jobs",
    id: "id",
    status: "status",
    progress: "progress",
    createdAt: "createdAt",
  },
}));

vi.mock("@/db/model_registry_schema", () => ({
  modelRegistryEntries: { __t: "model_registry_entries", id: "id" },
}));

vi.mock("@/db", () => {
  const pick = (t: any) => tables[t.__t];
  const db = {
    insert: (t: any) => ({
      values: (v: any) => ({ run: () => pick(t).push({ ...v }) }),
    }),
    update: (t: any) => ({
      set: (patch: any) => ({
        where: (pred: any) => ({
          run: () => {
            for (const row of pick(t)) if (pred(row)) Object.assign(row, patch);
          },
        }),
      }),
    }),
    select: () => ({
      from: (t: any) => {
        let pred: any;
        const api: any = {
          where: (p: any) => {
            pred = p;
            return api;
          },
          orderBy: () => api,
          limit: () => api,
          all: () => (pred ? pick(t).filter(pred) : [...pick(t)]),
          get: () => (pred ? pick(t).find(pred) : pick(t)[0]),
        };
        return api;
      },
    }),
  };
  return { getDb: () => db, db };
});

vi.mock("@/lib/runtime/activity_store", () => ({
  startActivity: (input: any) => {
    const id = `act-${activities.length}`;
    activities.push({ id, event: "start", detail: input });
    return id;
  },
  recordStep: (id: string, step: string) =>
    activities.push({ id, event: "step", detail: step }),
  completeActivity: (id: string) => activities.push({ id, event: "complete" }),
  failActivity: (id: string, e: unknown) =>
    activities.push({ id, event: "fail", detail: e }),
}));

import {
  createJob,
  getJob,
  listJobs,
  markCancelled,
  markCompleted,
  markFailed,
  markStarted,
  recordProgress,
  reconcileTrainingJobsAtBoot,
} from "@/lib/training_job_store";

const input = (over: Record<string, unknown> = {}) => ({
  name: "sentiment-lora",
  baseModelId: "mistral-7b",
  method: "qlora" as const,
  outputPath: "C:/adapters/job-1",
  totalEpochs: 3,
  hyperparameters: { loraR: 8, loraAlpha: 16, learningRate: 0.0002 },
  ...over,
});

beforeEach(() => {
  tables.training_jobs.length = 0;
  tables.model_registry_entries.length = 0;
  activities.length = 0;
});

describe("persisting a run", () => {
  it("writes a row that outlives the process that started it", () => {
    const id = createJob(input());

    const row = getJob(id)!;
    expect(row.name).toBe("sentiment-lora");
    expect(row.method).toBe("qlora");
    expect(row.status).toBe("queued");
    expect(row.totalEpochs).toBe(3);
  });

  it("mirrors the run into the activity record", () => {
    // A multi-hour fine-tune should appear in the tray count and the shell's
    // activity list like every other long-running thing the app does.
    createJob(input());
    const start = activities.find((a) => a.event === "start");
    expect(start).toBeDefined();
    expect((start!.detail as any).title).toMatch(/Fine-tune: sentiment-lora/);
  });

  it("records the pid so a dead process can be told from a stale row", () => {
    const id = createJob(input());
    markStarted(id, 4242);
    const row = getJob(id)!;
    expect(row.status).toBe("running");
    expect(row.pid).toBe(4242);
  });

  it("keeps epoch progress", () => {
    const id = createJob(input());
    markStarted(id, 1);
    recordProgress(id, { progress: 33, currentEpoch: 1, currentStep: 120 });

    const row = getJob(id)!;
    expect(row.progress).toBe(33);
    expect(row.currentEpoch).toBe(1);
    expect(row.currentStep).toBe(120);
  });

  it("lists jobs from previous sessions", () => {
    createJob(input({ name: "a" }));
    createJob(input({ name: "b" }));
    expect(listJobs().map((j) => j.name).sort()).toEqual(["a", "b"]);
  });
});

describe("completion registers the adapter", () => {
  it("inserts a fine_tuned entry into the model registry", () => {
    const id = createJob(input());
    markStarted(id, 1);

    const { registryId } = markCompleted(id);

    expect(registryId).toBeDefined();
    const entry = tables.model_registry_entries[0];
    expect(entry.modelType).toBe("fine_tuned");
    expect(entry.adapterType).toBe("qlora");
    expect(entry.baseModelId).toBe("mistral-7b");
    expect(entry.name).toBe("sentiment-lora");
  });

  it("carries the LoRA rank and alpha through from the hyperparameters", () => {
    const id = createJob(input());
    markCompleted(id);
    const entry = tables.model_registry_entries[0];
    expect(entry.adapterRank).toBe(8);
    expect(entry.adapterAlpha).toBe(16);
  });

  it("records training provenance on the entry", () => {
    const id = createJob(input({ datasetId: "ds-7" }));
    markCompleted(id);
    expect(tables.model_registry_entries[0].provenanceJson).toMatchObject({
      datasetId: "ds-7",
      epochs: 3,
      trainingMethod: "qlora",
    });
  });

  it("links the job back to the entry it produced", () => {
    const id = createJob(input());
    const { registryId } = markCompleted(id);
    expect(getJob(id)!.registryEntryId).toBe(registryId);
  });

  it("defaults rank and alpha when the run did not specify them", () => {
    const id = createJob(input({ hyperparameters: {} }));
    markCompleted(id);
    const entry = tables.model_registry_entries[0];
    expect(entry.adapterRank).toBe(16);
    expect(entry.adapterAlpha).toBe(32);
  });

  it("marks the mirrored activity complete", () => {
    const id = createJob(input());
    markCompleted(id);
    expect(activities.some((a) => a.event === "complete")).toBe(true);
  });
});

describe("failure and cancellation", () => {
  it("keeps the reason a run failed", () => {
    const id = createJob(input());
    markFailed(id, "CUDA out of memory");
    const row = getJob(id)!;
    expect(row.status).toBe("failed");
    expect(row.error).toMatch(/CUDA out of memory/);
    expect(row.pid).toBeNull();
  });

  it("does not register an adapter for a failed run", () => {
    const id = createJob(input());
    markFailed(id, "died");
    expect(tables.model_registry_entries).toHaveLength(0);
  });

  it("records a cancellation distinctly from a failure", () => {
    const id = createJob(input());
    markCancelled(id);
    expect(getJob(id)!.status).toBe("cancelled");
  });
});

describe("boot reconciliation", () => {
  it("marks a run whose process died as interrupted, not failed", () => {
    // Training is a child process; it cannot have survived the restart however
    // recently it reported progress. `interrupted` says the run stopped without
    // claiming the training itself went wrong.
    const id = createJob(input());
    markStarted(id, 999);
    recordProgress(id, { progress: 60, currentEpoch: 2 });

    expect(reconcileTrainingJobsAtBoot()).toBe(1);

    const row = getJob(id)!;
    expect(row.status).toBe("interrupted");
    expect(row.error).toMatch(/interrupted/i);
    expect(row.pid).toBeNull();
    // The partial progress survives, so the user can see how far it got.
    expect(row.progress).toBe(60);
    expect(row.currentEpoch).toBe(2);
    expect(row.outputPath).toBe("C:/adapters/job-1");
  });

  it("also clears jobs that were queued but never started", () => {
    createJob(input());
    expect(reconcileTrainingJobsAtBoot()).toBe(1);
    expect(getJob(listJobs()[0].id)!.status).toBe("interrupted");
  });

  it("leaves finished runs alone", () => {
    const done = createJob(input({ name: "done" }));
    markCompleted(done);
    const failed = createJob(input({ name: "failed" }));
    markFailed(failed, "oom");

    expect(reconcileTrainingJobsAtBoot()).toBe(0);
    expect(getJob(done)!.status).toBe("completed");
    expect(getJob(failed)!.status).toBe("failed");
  });

  it("reports nothing to do on a clean boot", () => {
    expect(reconcileTrainingJobsAtBoot()).toBe(0);
  });
});
