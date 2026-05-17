/**
 * DistillationScheduler tests — single-flight lock, settings gate,
 * min-sample threshold, manual vs idle paths, context-slot fan-out,
 * event publication, error capture.
 *
 * All deps (trainer, exporter, idle monitor, settings gate, slot updater,
 * event publisher, clock) are injected fakes — no electron, no python,
 * no db. The production wiring in `setupDistillationScheduler` is
 * exercised only through the "throw when unwired" path; the live DB +
 * powerMonitor integration is left to e2e.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

import {
  DistillationBusyError,
  DistillationScheduler,
  DistillationSkippedError,
  __resetDistillationSchedulerForTests,
  getDistillationScheduler,
  type DistillationReceipt,
  type DistillationSchedulerOptions,
  type DistillationTrainer,
  type DistillationTrainerInput,
  type IdleMonitor,
} from "../distillation_scheduler";
import type { EditLogEntry } from "../edit_logger";

vi.mock("electron-log", () => {
  const fn = () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  });
  return { default: { scope: vi.fn(fn) } };
});

// ── Fakes ────────────────────────────────────────────────────────────────

function makeEntries(count: number, baseMs = 1_000): EditLogEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    projectId: 1,
    fileId: "file://main.ts",
    op: "insert",
    range: { startLine: 1, startCol: 0, endLine: 1, endCol: 1 },
    textHash: `hash-${i}`,
    textLength: 1,
    sequence: i + 1,
    occurredAtMs: baseMs + i,
  }));
}

function makeFakeIdleMonitor(): IdleMonitor & {
  fire: () => void;
  started: boolean;
  stopCount: number;
} {
  let cb: (() => void) | null = null;
  const obj = {
    started: false,
    stopCount: 0,
    fire() {
      cb?.();
    },
    start(onTick: () => void) {
      obj.started = true;
      cb = onTick;
      return () => {
        obj.started = false;
        obj.stopCount += 1;
        cb = null;
      };
    },
  };
  return obj;
}

function makeTrainer(
  impl?: (input: DistillationTrainerInput) => Promise<DistillationReceipt>,
): DistillationTrainer & { calls: DistillationTrainerInput[] } {
  const calls: DistillationTrainerInput[] = [];
  const trainer: DistillationTrainer & { calls: DistillationTrainerInput[] } = {
    calls,
    train: vi.fn(async (input) => {
      calls.push(input);
      if (impl) return impl(input);
      return {
        adapterId: `adapter-${calls.length}`,
        method: "qlora",
        sampleCount: input.entries.length,
        finalLoss: 0.123,
        durationMs: 50,
        baseModelId: input.baseModelId,
      };
    }),
  };
  return trainer;
}

function makeBaseOpts(
  overrides: Partial<DistillationSchedulerOptions> = {},
): DistillationSchedulerOptions {
  return {
    trainer: makeTrainer(),
    editLogExporter: vi.fn(async () => makeEntries(20)),
    idleMonitor: makeFakeIdleMonitor(),
    settingsGate: () => true,
    activeProjectResolver: async () => 1,
    defaultBaseModelId: "phi-3-mini-4k-int4",
    clock: () => 100_000,
    windowMs: 60_000,
    minSampleCount: 5,
    ...overrides,
  };
}

// ── Constructor ──────────────────────────────────────────────────────────

describe("DistillationScheduler — constructor", () => {
  it("throws when trainer missing", () => {
    expect(
      () =>
        new DistillationScheduler({
          ...makeBaseOpts(),
          trainer: undefined as unknown as DistillationTrainer,
        }),
    ).toThrow(/trainer/);
  });

  it("throws when editLogExporter missing", () => {
    expect(
      () =>
        new DistillationScheduler({
          ...makeBaseOpts(),
          editLogExporter: undefined as unknown as DistillationSchedulerOptions["editLogExporter"],
        }),
    ).toThrow(/editLogExporter/);
  });

  it("throws when idleMonitor missing", () => {
    expect(
      () =>
        new DistillationScheduler({
          ...makeBaseOpts(),
          idleMonitor: undefined as unknown as IdleMonitor,
        }),
    ).toThrow(/idleMonitor/);
  });

  it("throws when settingsGate missing", () => {
    expect(
      () =>
        new DistillationScheduler({
          ...makeBaseOpts(),
          settingsGate: undefined as unknown as () => boolean,
        }),
    ).toThrow(/settingsGate/);
  });

  it("throws when activeProjectResolver missing", () => {
    expect(
      () =>
        new DistillationScheduler({
          ...makeBaseOpts(),
          activeProjectResolver: undefined as unknown as () => Promise<number | null>,
        }),
    ).toThrow(/activeProjectResolver/);
  });

  it("throws when defaultBaseModelId is empty", () => {
    expect(
      () =>
        new DistillationScheduler({
          ...makeBaseOpts(),
          defaultBaseModelId: "",
        }),
    ).toThrow(/defaultBaseModelId/);
  });

  it("throws when windowMs is not positive", () => {
    expect(
      () => new DistillationScheduler({ ...makeBaseOpts(), windowMs: 0 }),
    ).toThrow(/windowMs/);
  });

  it("throws when maxSampleCount < minSampleCount", () => {
    expect(
      () =>
        new DistillationScheduler({
          ...makeBaseOpts(),
          minSampleCount: 100,
          maxSampleCount: 10,
        }),
    ).toThrow(/maxSampleCount/);
  });
});

// ── start/stop ───────────────────────────────────────────────────────────

describe("DistillationScheduler — start/stop", () => {
  it("start is idempotent and respects settings gate", () => {
    const monitor = makeFakeIdleMonitor();
    const sched = new DistillationScheduler(
      makeBaseOpts({ idleMonitor: monitor, settingsGate: () => false }),
    );
    sched.start();
    expect(monitor.started).toBe(false);
    expect(sched.getStatus().monitorActive).toBe(false);
  });

  it("start when enabled wires the monitor; double start no-ops", () => {
    const monitor = makeFakeIdleMonitor();
    const sched = new DistillationScheduler(
      makeBaseOpts({ idleMonitor: monitor }),
    );
    sched.start();
    sched.start();
    expect(monitor.started).toBe(true);
    expect(sched.getStatus().monitorActive).toBe(true);
  });

  it("stop disposes monitor; double stop no-ops", () => {
    const monitor = makeFakeIdleMonitor();
    const sched = new DistillationScheduler(
      makeBaseOpts({ idleMonitor: monitor }),
    );
    sched.start();
    sched.stop();
    sched.stop();
    expect(monitor.stopCount).toBe(1);
    expect(sched.getStatus().monitorActive).toBe(false);
  });

  it("survives monitor disposer throwing", () => {
    const monitor: IdleMonitor = {
      start: () => () => {
        throw new Error("dispose boom");
      },
    };
    const sched = new DistillationScheduler(
      makeBaseOpts({ idleMonitor: monitor }),
    );
    sched.start();
    expect(() => sched.stop()).not.toThrow();
    expect(sched.getStatus().monitorActive).toBe(false);
  });
});

// ── runNow validation ────────────────────────────────────────────────────

describe("DistillationScheduler — runNow validation", () => {
  it("rejects non-integer projectId", async () => {
    const sched = new DistillationScheduler(makeBaseOpts());
    await expect(sched.runNow(0)).rejects.toThrow(/projectId/);
    await expect(sched.runNow(-1)).rejects.toThrow(/projectId/);
    await expect(sched.runNow(1.5)).rejects.toThrow(/projectId/);
  });
});

// ── Single-flight lock ───────────────────────────────────────────────────

describe("DistillationScheduler — single-flight", () => {
  it("second concurrent runNow throws DistillationBusyError", async () => {
    let release!: (r: DistillationReceipt) => void;
    const slow = new Promise<DistillationReceipt>((resolve) => {
      release = resolve;
    });
    const trainer = makeTrainer(() => slow);
    const sched = new DistillationScheduler(
      makeBaseOpts({ trainer, editLogExporter: async () => makeEntries(10) }),
    );
    const first = sched.runNow(1);
    await expect(sched.runNow(1)).rejects.toBeInstanceOf(DistillationBusyError);
    release({
      adapterId: "a1",
      method: "qlora",
      sampleCount: 10,
      finalLoss: 0.1,
      durationMs: 1,
      baseModelId: "phi-3-mini-4k-int4",
    });
    await first;
  });

  it("releases the lock on failure", async () => {
    const trainer = makeTrainer(async () => {
      throw new Error("trainer boom");
    });
    const sched = new DistillationScheduler(
      makeBaseOpts({ trainer, editLogExporter: async () => makeEntries(10) }),
    );
    await expect(sched.runNow(1)).rejects.toThrow(/trainer boom/);
    // Lock released — second call hits trainer again (and fails again).
    await expect(sched.runNow(1)).rejects.toThrow(/trainer boom/);
    expect(trainer.train).toHaveBeenCalledTimes(2);
    expect(sched.getStatus().running).toBe(false);
  });
});

// ── Min-sample threshold ─────────────────────────────────────────────────

describe("DistillationScheduler — sample threshold", () => {
  it("skips when entries < minSampleCount", async () => {
    const trainer = makeTrainer();
    const sched = new DistillationScheduler(
      makeBaseOpts({
        trainer,
        editLogExporter: async () => makeEntries(3),
        minSampleCount: 10,
      }),
    );
    await expect(sched.runNow(1)).rejects.toBeInstanceOf(
      DistillationSkippedError,
    );
    expect(trainer.train).not.toHaveBeenCalled();
  });

  it("trains when entries ≥ minSampleCount", async () => {
    const trainer = makeTrainer();
    const sched = new DistillationScheduler(
      makeBaseOpts({
        trainer,
        editLogExporter: async () => makeEntries(10),
        minSampleCount: 5,
      }),
    );
    const receipt = await sched.runNow(1);
    expect(receipt.adapterId).toBe("adapter-1");
    expect(trainer.train).toHaveBeenCalledTimes(1);
    expect(trainer.calls[0].entries).toHaveLength(10);
    expect(trainer.calls[0].method).toBe("qlora");
  });
});

// ── Window calculation ───────────────────────────────────────────────────

describe("DistillationScheduler — window calculation", () => {
  it("exports edits within the configured window", async () => {
    const exporter = vi.fn(async () => makeEntries(20));
    const sched = new DistillationScheduler(
      makeBaseOpts({
        editLogExporter: exporter,
        clock: () => 1_000_000,
        windowMs: 60_000,
      }),
    );
    await sched.runNow(1);
    expect(exporter).toHaveBeenCalledWith({
      projectId: 1,
      sinceMs: 940_000,
      limit: 10_000,
    });
  });

  it("clamps sinceMs to zero when window exceeds clock", async () => {
    const exporter = vi.fn(async () => makeEntries(20));
    const sched = new DistillationScheduler(
      makeBaseOpts({
        editLogExporter: exporter,
        clock: () => 100,
        windowMs: 60_000,
      }),
    );
    await sched.runNow(1);
    expect(exporter.mock.calls[0][0].sinceMs).toBe(0);
  });
});

// ── Receipt validation ───────────────────────────────────────────────────

describe("DistillationScheduler — receipt validation", () => {
  it("throws when trainer returns no adapterId", async () => {
    const trainer = makeTrainer(async (input) => ({
      adapterId: "",
      method: "qlora",
      sampleCount: input.entries.length,
      finalLoss: 0,
      durationMs: 1,
      baseModelId: input.baseModelId,
    }));
    const sched = new DistillationScheduler(
      makeBaseOpts({ trainer, editLogExporter: async () => makeEntries(10) }),
    );
    await expect(sched.runNow(1)).rejects.toThrow(/adapterId/);
  });
});

// ── Context slot fan-out ─────────────────────────────────────────────────

describe("DistillationScheduler — context slot fan-out", () => {
  it("forwards adapter bytes to updateContextSlot when provided", async () => {
    const updateContextSlot = vi.fn(async () => undefined);
    const adapterBytes = new Uint8Array([1, 2, 3]);
    const trainer = makeTrainer(async (input) => ({
      adapterId: "a1",
      method: "qlora",
      sampleCount: input.entries.length,
      finalLoss: 0.1,
      durationMs: 1,
      adapterBytes,
      baseModelId: input.baseModelId,
    }));
    const sched = new DistillationScheduler(
      makeBaseOpts({
        trainer,
        editLogExporter: async () => makeEntries(10),
        updateContextSlot,
      }),
    );
    await sched.runNow(42);
    expect(updateContextSlot).toHaveBeenCalledWith({
      projectId: "42",
      baseModelId: "phi-3-mini-4k-int4",
      adapterBytes,
    });
  });

  it("does not call updateContextSlot when receipt has no bytes", async () => {
    const updateContextSlot = vi.fn(async () => undefined);
    const sched = new DistillationScheduler(
      makeBaseOpts({
        editLogExporter: async () => makeEntries(10),
        updateContextSlot,
      }),
    );
    await sched.runNow(1);
    expect(updateContextSlot).not.toHaveBeenCalled();
  });

  it("slot-update failure does NOT fail the run", async () => {
    const updateContextSlot = vi.fn(async () => {
      throw new Error("slot boom");
    });
    const trainer = makeTrainer(async (input) => ({
      adapterId: "a1",
      method: "qlora",
      sampleCount: input.entries.length,
      finalLoss: 0.1,
      durationMs: 1,
      adapterBytes: new Uint8Array([9]),
      baseModelId: input.baseModelId,
    }));
    const sched = new DistillationScheduler(
      makeBaseOpts({
        trainer,
        editLogExporter: async () => makeEntries(10),
        updateContextSlot,
      }),
    );
    const receipt = await sched.runNow(1);
    expect(receipt.adapterId).toBe("a1");
  });
});

// ── Domain event publication ─────────────────────────────────────────────

describe("DistillationScheduler — event publication", () => {
  it("publishes genius_core.distillation.completed on success", async () => {
    const publishCompletion = vi.fn(async () => undefined);
    const sched = new DistillationScheduler(
      makeBaseOpts({
        editLogExporter: async () => makeEntries(10),
        publishCompletion,
      }),
    );
    await sched.runNow(7);
    expect(publishCompletion).toHaveBeenCalledTimes(1);
    expect(publishCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "7",
        adapterId: "adapter-1",
        method: "qlora",
        sampleCount: 10,
        finalLoss: 0.123,
      }),
    );
  });

  it("does not publish when trainer throws", async () => {
    const publishCompletion = vi.fn(async () => undefined);
    const trainer = makeTrainer(async () => {
      throw new Error("nope");
    });
    const sched = new DistillationScheduler(
      makeBaseOpts({
        trainer,
        editLogExporter: async () => makeEntries(10),
        publishCompletion,
      }),
    );
    await expect(sched.runNow(1)).rejects.toThrow(/nope/);
    expect(publishCompletion).not.toHaveBeenCalled();
  });

  it("publisher failure does NOT fail the run", async () => {
    const publishCompletion = vi.fn(async () => {
      throw new Error("bus down");
    });
    const sched = new DistillationScheduler(
      makeBaseOpts({
        editLogExporter: async () => makeEntries(10),
        publishCompletion,
      }),
    );
    const receipt = await sched.runNow(1);
    expect(receipt.adapterId).toBe("adapter-1");
  });
});

// ── Idle path ────────────────────────────────────────────────────────────

describe("DistillationScheduler — idle path", () => {
  it("idle tick runs when gate + active project resolve", async () => {
    const monitor = makeFakeIdleMonitor();
    const trainer = makeTrainer();
    const sched = new DistillationScheduler(
      makeBaseOpts({
        idleMonitor: monitor,
        trainer,
        editLogExporter: async () => makeEntries(10),
        activeProjectResolver: async () => 99,
      }),
    );
    sched.start();
    monitor.fire();
    // allow the async handler to settle
    await new Promise((r) => setImmediate(r));
    expect(trainer.train).toHaveBeenCalledTimes(1);
    expect(trainer.calls[0].projectId).toBe(99);
  });

  it("idle tick skipped when gate is off (rechecked live)", async () => {
    const monitor = makeFakeIdleMonitor();
    const trainer = makeTrainer();
    let gateOn = true;
    const sched = new DistillationScheduler(
      makeBaseOpts({
        idleMonitor: monitor,
        trainer,
        settingsGate: () => gateOn,
        editLogExporter: async () => makeEntries(10),
      }),
    );
    sched.start();
    gateOn = false;
    monitor.fire();
    await new Promise((r) => setImmediate(r));
    expect(trainer.train).not.toHaveBeenCalled();
  });

  it("idle tick skipped when no active project", async () => {
    const monitor = makeFakeIdleMonitor();
    const trainer = makeTrainer();
    const sched = new DistillationScheduler(
      makeBaseOpts({
        idleMonitor: monitor,
        trainer,
        activeProjectResolver: async () => null,
        editLogExporter: async () => makeEntries(10),
      }),
    );
    sched.start();
    monitor.fire();
    await new Promise((r) => setImmediate(r));
    expect(trainer.train).not.toHaveBeenCalled();
  });

  it("idle tick swallows trainer errors silently", async () => {
    const monitor = makeFakeIdleMonitor();
    const trainer = makeTrainer(async () => {
      throw new Error("idle boom");
    });
    const sched = new DistillationScheduler(
      makeBaseOpts({
        idleMonitor: monitor,
        trainer,
        editLogExporter: async () => makeEntries(10),
      }),
    );
    sched.start();
    monitor.fire();
    await new Promise((r) => setImmediate(r));
    expect(sched.getStatus().lastError?.message).toBe("idle boom");
    expect(sched.getStatus().running).toBe(false);
  });

  it("idle tick is no-op while a manual run is in flight", async () => {
    const monitor = makeFakeIdleMonitor();
    let release!: (r: DistillationReceipt) => void;
    const trainer = makeTrainer(
      () =>
        new Promise<DistillationReceipt>((resolve) => {
          release = resolve;
        }),
    );
    const sched = new DistillationScheduler(
      makeBaseOpts({
        idleMonitor: monitor,
        trainer,
        editLogExporter: async () => makeEntries(10),
      }),
    );
    sched.start();
    const manual = sched.runNow(1);
    monitor.fire();
    await new Promise((r) => setImmediate(r));
    expect(trainer.train).toHaveBeenCalledTimes(1);
    release({
      adapterId: "a1",
      method: "qlora",
      sampleCount: 10,
      finalLoss: 0,
      durationMs: 1,
      baseModelId: "phi-3-mini-4k-int4",
    });
    await manual;
  });
});

// ── Status snapshot ──────────────────────────────────────────────────────

describe("DistillationScheduler — status", () => {
  it("getStatus reflects successful run", async () => {
    let now = 1_000_000;
    const sched = new DistillationScheduler(
      makeBaseOpts({
        editLogExporter: async () => makeEntries(10),
        clock: () => now,
      }),
    );
    await sched.runNow(5);
    now = 2_000_000;
    const status = sched.getStatus();
    expect(status.running).toBe(false);
    expect(status.lastRun).toMatchObject({
      projectId: 5,
      source: "manual",
      sampleCount: 10,
      adapterId: "adapter-1",
    });
    expect(status.lastError).toBeNull();
    expect(status.runCount).toBe(1);
  });

  it("getStatus reflects last error after failure", async () => {
    const trainer = makeTrainer(async () => {
      throw new Error("kaboom");
    });
    const sched = new DistillationScheduler(
      makeBaseOpts({
        trainer,
        editLogExporter: async () => makeEntries(10),
      }),
    );
    await expect(sched.runNow(1)).rejects.toThrow();
    const status = sched.getStatus();
    expect(status.lastError?.message).toBe("kaboom");
    expect(status.runCount).toBe(1);
  });
});

// ── Singleton wiring ─────────────────────────────────────────────────────

describe("singleton wiring", () => {
  beforeEach(() => {
    __resetDistillationSchedulerForTests();
  });

  it("getDistillationScheduler throws before setup", () => {
    expect(() => getDistillationScheduler()).toThrow(/not initialised/);
  });
});
