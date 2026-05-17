/**
 * EditLogger tests — privacy gate, debounce, ordering, overflow.
 *
 * All tests run against the runtime-agnostic `EditLogger` class with
 * injected fakes for gate / writer / scheduler / clock. The production
 * `setupEditLogger` wiring is exercised through __resetEditLoggerForTests
 * + getEditLogger throw assertion only — full DB integration is left to
 * the IPC handler integration tests.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

import {
  EditLogger,
  exportSession,
  getEditLogger,
  __resetEditLoggerForTests,
  type EditLogEntry,
  type EditLoggerOptions,
  type RecordInput,
} from "../edit_logger";

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

interface FakeTimer {
  fn: () => void;
  due: number;
  cancelled: boolean;
}

function makeScheduler() {
  const timers: FakeTimer[] = [];
  let now = 0;
  const scheduler: EditLoggerOptions["scheduler"] = (fn, ms) => {
    const t: FakeTimer = { fn, due: now + ms, cancelled: false };
    timers.push(t);
    return t as unknown as ReturnType<typeof setTimeout>;
  };
  const cancel: EditLoggerOptions["cancel"] = (handle) => {
    const t = handle as unknown as FakeTimer;
    t.cancelled = true;
  };
  const advance = (ms: number) => {
    now += ms;
    const due = timers.filter((t) => !t.cancelled && t.due <= now);
    for (const t of due) {
      t.cancelled = true;
      t.fn();
    }
  };
  return { scheduler, cancel, advance, timers, getNow: () => now };
}

function makeWriter() {
  const calls: EditLogEntry[][] = [];
  let failNext: Error | null = null;
  const writer = vi.fn(async (entries: EditLogEntry[]) => {
    if (failNext) {
      const e = failNext;
      failNext = null;
      throw e;
    }
    calls.push(entries.map((e) => ({ ...e, range: { ...e.range } })));
  });
  return {
    writer,
    calls,
    failOnce: (err: Error) => {
      failNext = err;
    },
  };
}

function baseInput(overrides: Partial<RecordInput> = {}): RecordInput {
  return {
    projectId: 1,
    fileId: "f.txt",
    op: "insert",
    range: { startLine: 0, startCol: 0, endLine: 0, endCol: 1 },
    text: "x",
    ...overrides,
  };
}

function makeLogger(
  overrides: Partial<EditLoggerOptions> & { gateValue?: boolean } = {},
) {
  const { writer, calls, failOnce } = makeWriter();
  const sched = makeScheduler();
  const gateValueRef = { current: overrides.gateValue ?? true };
  const gate =
    overrides.gate ??
    (() => gateValueRef.current);
  let nowMs = 1000;
  const clock = overrides.clock ?? (() => nowMs++);
  const logger = new EditLogger({
    gate,
    writer,
    debounceMs: overrides.debounceMs ?? 100,
    maxBufferSize: overrides.maxBufferSize ?? 1024,
    clock,
    scheduler: sched.scheduler,
    cancel: sched.cancel,
  });
  return {
    logger,
    writer,
    calls,
    failOnce,
    advance: sched.advance,
    setGate: (v: boolean) => {
      gateValueRef.current = v;
    },
    setNow: (v: number) => {
      nowMs = v;
    },
  };
}

beforeEach(() => {
  __resetEditLoggerForTests();
});

// ── Constructor ──────────────────────────────────────────────────────────

describe("EditLogger constructor", () => {
  it("rejects missing gate / writer", () => {
    expect(
      () =>
        new EditLogger({
          gate: undefined as unknown as () => boolean,
          writer: vi.fn(),
        }),
    ).toThrow(/gate/);
    expect(
      () =>
        new EditLogger({
          gate: () => true,
          writer: undefined as unknown as () => Promise<void>,
        }),
    ).toThrow(/writer/);
  });
});

// ── Input validation ─────────────────────────────────────────────────────

describe("EditLogger.record input validation", () => {
  it("rejects non-object input", () => {
    const { logger } = makeLogger();
    expect(() => logger.record(null as unknown as RecordInput)).toThrow(
      /input object/,
    );
  });

  it("rejects invalid projectId / fileId / op", () => {
    const { logger } = makeLogger();
    expect(() => logger.record(baseInput({ projectId: 0 }))).toThrow(
      /projectId/,
    );
    expect(() => logger.record(baseInput({ projectId: 1.5 }))).toThrow(
      /projectId/,
    );
    expect(() => logger.record(baseInput({ fileId: "" }))).toThrow(/fileId/);
    expect(() =>
      logger.record(baseInput({ op: "bogus" as unknown as "insert" })),
    ).toThrow(/unknown op/);
  });

  it("rejects malformed range", () => {
    const { logger } = makeLogger();
    expect(() =>
      logger.record(
        baseInput({
          range: { startLine: -1, startCol: 0, endLine: 0, endCol: 0 },
        }),
      ),
    ).toThrow(/range/);
    expect(() =>
      logger.record(
        baseInput({
          range: undefined as unknown as RecordInput["range"],
        }),
      ),
    ).toThrow(/range/);
  });

  it("rejects non-string text when provided", () => {
    const { logger } = makeLogger();
    expect(() =>
      logger.record(baseInput({ text: 123 as unknown as string })),
    ).toThrow(/text/);
  });
});

// ── Privacy gate ─────────────────────────────────────────────────────────

describe("EditLogger privacy gate", () => {
  it("drops records when the gate is closed (returns false, no write)", async () => {
    const { logger, writer, advance, calls } = makeLogger({ gateValue: false });
    expect(logger.record(baseInput())).toBe(false);
    advance(500);
    await logger.flush();
    expect(writer).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it("opens / closes mid-session live", async () => {
    const { logger, writer, advance, setGate, calls } = makeLogger({
      gateValue: false,
    });
    logger.record(baseInput({ text: "a" }));
    setGate(true);
    logger.record(baseInput({ text: "b" }));
    setGate(false);
    logger.record(baseInput({ text: "c" }));
    advance(200);
    await logger.flush();
    expect(writer).toHaveBeenCalledTimes(1);
    expect(calls[0]).toHaveLength(1);
    expect(calls[0][0].textLength).toBe(1);
  });

  it("treats a throwing gate as closed", () => {
    const logger = new EditLogger({
      gate: () => {
        throw new Error("boom");
      },
      writer: vi.fn(),
    });
    expect(logger.record(baseInput())).toBe(false);
  });
});

// ── Debounce & ordering ──────────────────────────────────────────────────

describe("EditLogger debounce & ordering", () => {
  it("coalesces multiple records into one writer call after debounce", async () => {
    const { logger, writer, advance, calls } = makeLogger({ debounceMs: 100 });
    logger.record(baseInput({ text: "a" }));
    logger.record(baseInput({ text: "b" }));
    logger.record(baseInput({ text: "c" }));
    expect(writer).not.toHaveBeenCalled();
    advance(99);
    expect(writer).not.toHaveBeenCalled();
    advance(1);
    // Allow microtasks to drain.
    await Promise.resolve();
    expect(writer).toHaveBeenCalledTimes(1);
    expect(calls[0]).toHaveLength(3);
    // Ordering preserved.
    expect(calls[0].map((e) => e.textLength)).toEqual([1, 1, 1]);
    expect(calls[0].map((e) => e.sequence)).toEqual([1, 2, 3]);
  });

  it("hashes text and never stores plaintext", async () => {
    const { logger, advance, calls } = makeLogger();
    logger.record(baseInput({ text: "secret-token" }));
    advance(200);
    await logger.flush();
    const entry = calls[0][0];
    expect(entry.textLength).toBe("secret-token".length);
    expect(entry.textHash).toBeTruthy();
    expect(entry.textHash).not.toContain("secret");
    expect(entry).not.toHaveProperty("text");
  });

  it("emits null hash + zero length for cursor / ai_* ops", async () => {
    const { logger, advance, calls } = makeLogger();
    logger.record(baseInput({ op: "cursor", text: undefined }));
    logger.record(baseInput({ op: "ai_accept", text: undefined }));
    advance(200);
    await logger.flush();
    expect(calls[0][0].textHash).toBe(null);
    expect(calls[0][0].textLength).toBe(0);
    expect(calls[0][1].textHash).toBe(null);
  });

  it("manual flush bypasses the debounce timer", async () => {
    const { logger, writer, advance } = makeLogger({ debounceMs: 5000 });
    logger.record(baseInput());
    await logger.flush();
    expect(writer).toHaveBeenCalledTimes(1);
    // Timer should be cancelled — advancing past the debounce doesn't fire again.
    advance(5000);
    await Promise.resolve();
    expect(writer).toHaveBeenCalledTimes(1);
  });

  it("flush on empty buffer is a no-op", async () => {
    const { logger, writer } = makeLogger();
    await logger.flush();
    expect(writer).not.toHaveBeenCalled();
  });

  it("respects occurredAtMs override for deterministic ordering", async () => {
    const { logger, advance, calls } = makeLogger();
    logger.record(baseInput({ occurredAtMs: 42 }));
    advance(200);
    await logger.flush();
    expect(calls[0][0].occurredAtMs).toBe(42);
  });
});

// ── Sequence monotonicity ────────────────────────────────────────────────

describe("EditLogger sequence numbers", () => {
  it("issues strictly increasing sequence numbers across batches", async () => {
    const { logger, advance, calls } = makeLogger();
    logger.record(baseInput());
    logger.record(baseInput());
    advance(200);
    await logger.flush();
    logger.record(baseInput());
    advance(200);
    await logger.flush();
    expect(calls).toHaveLength(2);
    const all = calls.flat().map((e) => e.sequence);
    expect(all).toEqual([1, 2, 3]);
  });

  it("does not advance sequence when the gate is closed", async () => {
    const { logger, advance, setGate, calls } = makeLogger({ gateValue: false });
    logger.record(baseInput());
    logger.record(baseInput());
    setGate(true);
    logger.record(baseInput());
    advance(200);
    await logger.flush();
    expect(calls[0][0].sequence).toBe(1);
  });
});

// ── Overflow ─────────────────────────────────────────────────────────────

describe("EditLogger overflow", () => {
  it("drops oldest entries when buffer exceeds maxBufferSize", async () => {
    const { logger, advance, calls } = makeLogger({ maxBufferSize: 3 });
    for (let i = 0; i < 5; i++) logger.record(baseInput({ text: String(i) }));
    advance(200);
    await logger.flush();
    expect(logger.status().droppedOnOverflow).toBe(2);
    expect(calls[0]).toHaveLength(3);
    expect(calls[0].map((e) => e.sequence)).toEqual([3, 4, 5]);
  });
});

// ── Writer failure ───────────────────────────────────────────────────────

describe("EditLogger writer failure", () => {
  it("restores the batch for retry when the writer throws", async () => {
    const { logger, writer, failOnce, advance, calls } = makeLogger();
    logger.record(baseInput({ text: "a" }));
    failOnce(new Error("disk full"));
    advance(200);
    await expect(logger.flush()).rejects.toThrow(/disk full/);
    expect(logger.status().bufferSize).toBe(1);

    // Retry succeeds.
    await logger.flush();
    expect(writer).toHaveBeenCalledTimes(2);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(1);
  });
});

// ── Dispose ──────────────────────────────────────────────────────────────

describe("EditLogger.dispose", () => {
  it("drops pending entries and refuses further records", async () => {
    const { logger, writer, advance } = makeLogger();
    logger.record(baseInput());
    await logger.dispose();
    expect(logger.record(baseInput())).toBe(false);
    advance(500);
    expect(writer).not.toHaveBeenCalled();
    expect(logger.status().disposed).toBe(true);
    expect(logger.status().bufferSize).toBe(0);
  });
});

// ── Singleton ────────────────────────────────────────────────────────────

describe("EditLogger singleton", () => {
  it("getEditLogger throws before setup", () => {
    expect(() => getEditLogger()).toThrow(/not initialised/);
  });
});

// ── exportSession input validation ───────────────────────────────────────

describe("exportSession input validation", () => {
  it("rejects invalid projectId / sinceMs / limit", async () => {
    await expect(
      exportSession({ projectId: 0, sinceMs: 0 }),
    ).rejects.toThrow(/projectId/);
    await expect(
      exportSession({ projectId: 1, sinceMs: -1 }),
    ).rejects.toThrow(/sinceMs/);
    await expect(
      exportSession({ projectId: 1, sinceMs: 0, limit: 0 }),
    ).rejects.toThrow(/limit/);
  });
});
