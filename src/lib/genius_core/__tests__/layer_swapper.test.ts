/**
 * LayerSwapper tests — bookkeeping + LRU semantics.
 *
 * The swapper is runtime-agnostic, so every test uses a tiny in-memory
 * loader that just hands back a tagged object. We use an injected
 * monotonic clock so recency assertions are deterministic.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

import {
  LayerSwapper,
  type LayerSwapperEvent,
  type LayerSpec,
  gbToBytes,
} from "../layer_swapper";

// Logger mock so the warn path under dispose-throws doesn't spam vitest.
vi.mock("electron-log", () => {
  const fn = () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  });
  const scope = vi.fn(fn);
  return { default: { scope } };
});

interface FakeHandle {
  tag: string;
}

function makeSpec(
  id: string,
  bytes: number,
  overrides: Partial<LayerSpec<FakeHandle>> = {},
): LayerSpec<FakeHandle> {
  return {
    id,
    bytes,
    load: vi.fn(async () => ({ tag: id })),
    dispose: vi.fn(),
    ...overrides,
  };
}

// Drains any tasks scheduled by void promises so eviction `slot-released`
// events have a chance to fire before assertions.
async function flush(n = 4) {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

// ── Lifecycle ────────────────────────────────────────────────────────────

describe("LayerSwapper constructor", () => {
  it("rejects non-positive budget", () => {
    expect(() => new LayerSwapper({ budgetBytes: 0 })).toThrow(/positive/);
    expect(() => new LayerSwapper({ budgetBytes: -1 })).toThrow(/positive/);
    expect(() => new LayerSwapper({ budgetBytes: Number.NaN })).toThrow(/positive/);
  });

  it("accepts a positive budget without an onEvent hook", () => {
    expect(() => new LayerSwapper({ budgetBytes: 100 })).not.toThrow();
  });
});

// ── pinBase ──────────────────────────────────────────────────────────────

describe("LayerSwapper.pinBase", () => {
  let events: LayerSwapperEvent[];
  beforeEach(() => {
    events = [];
  });

  it("loads the base, emits base-pinned, and counts against the budget", async () => {
    const sw = new LayerSwapper({
      budgetBytes: 1000,
      onEvent: (e) => events.push(e),
    });
    const spec = makeSpec("base/v1", 200);
    const handle = await sw.pinBase(spec);
    expect(handle).toEqual({ tag: "base/v1" });
    expect(spec.load).toHaveBeenCalledTimes(1);
    expect(events).toEqual([{ type: "base-pinned", id: "base/v1", bytes: 200 }]);
    const s = sw.status();
    expect(s.baseId).toBe("base/v1");
    expect(s.baseBytes).toBe(200);
    expect(s.freeBytes).toBe(800);
  });

  it("rejects when the base alone exceeds the budget and emits budget-exceeded", async () => {
    const sw = new LayerSwapper({
      budgetBytes: 100,
      onEvent: (e) => events.push(e),
    });
    await expect(sw.pinBase(makeSpec("big", 500))).rejects.toThrow(/exceeds budget/);
    expect(events).toEqual([
      { type: "budget-exceeded", requestedBytes: 500, budgetBytes: 100 },
    ]);
  });

  it("is idempotent for the same base id", async () => {
    const sw = new LayerSwapper({ budgetBytes: 1000 });
    const spec = makeSpec("base/v1", 100);
    const h1 = await sw.pinBase(spec);
    const h2 = await sw.pinBase(spec);
    expect(h1).toBe(h2);
    expect(spec.load).toHaveBeenCalledTimes(1);
  });

  it("rejects when a different base is already pinned", async () => {
    const sw = new LayerSwapper({ budgetBytes: 1000 });
    await sw.pinBase(makeSpec("base/v1", 100));
    await expect(sw.pinBase(makeSpec("base/v2", 100))).rejects.toThrow(
      /already has base/,
    );
  });
});

// ── acquire ──────────────────────────────────────────────────────────────

describe("LayerSwapper.acquire", () => {
  it("loads, emits slot-loaded, and returns the handle", async () => {
    const events: LayerSwapperEvent[] = [];
    const sw = new LayerSwapper({
      budgetBytes: 1000,
      onEvent: (e) => events.push(e),
    });
    const spec = makeSpec("slot/a", 200);
    const h = await sw.acquire(spec);
    expect(h).toEqual({ tag: "slot/a" });
    expect(events).toContainEqual({ type: "slot-loaded", id: "slot/a", bytes: 200 });
  });

  it("returns the cached handle and emits slot-touched on a second acquire", async () => {
    const events: LayerSwapperEvent[] = [];
    const sw = new LayerSwapper({
      budgetBytes: 1000,
      onEvent: (e) => events.push(e),
    });
    const spec = makeSpec("slot/a", 200);
    const h1 = await sw.acquire(spec);
    const h2 = await sw.acquire(spec);
    expect(h1).toBe(h2);
    expect(spec.load).toHaveBeenCalledTimes(1);
    expect(events.filter((e) => e.type === "slot-touched")).toHaveLength(1);
  });

  it("rejects invalid byte sizes", async () => {
    const sw = new LayerSwapper({ budgetBytes: 1000 });
    await expect(sw.acquire(makeSpec("bad", Number.NaN))).rejects.toThrow(/invalid/);
    await expect(sw.acquire(makeSpec("bad", -1))).rejects.toThrow(/invalid/);
  });

  it("rejects when the slot alone exceeds budget − base", async () => {
    const events: LayerSwapperEvent[] = [];
    const sw = new LayerSwapper({
      budgetBytes: 500,
      onEvent: (e) => events.push(e),
    });
    await sw.pinBase(makeSpec("base", 200));
    await expect(sw.acquire(makeSpec("huge", 400))).rejects.toThrow(/cannot fit/);
    expect(events).toContainEqual({
      type: "budget-exceeded",
      requestedBytes: 400,
      budgetBytes: 500,
    });
  });

  it("coalesces concurrent acquires for the same id", async () => {
    const sw = new LayerSwapper({ budgetBytes: 1000 });
    let resolveLoad!: (h: FakeHandle) => void;
    const loadFn = vi.fn(
      () => new Promise<FakeHandle>((r) => (resolveLoad = r)),
    );
    const spec: LayerSpec<FakeHandle> = {
      id: "slot/x",
      bytes: 100,
      load: loadFn,
    };
    const p1 = sw.acquire(spec);
    const p2 = sw.acquire(spec);
    const p3 = sw.acquire(spec);
    expect(loadFn).toHaveBeenCalledTimes(1);
    resolveLoad({ tag: "slot/x" });
    const [h1, h2, h3] = await Promise.all([p1, p2, p3]);
    expect(h1).toBe(h2);
    expect(h2).toBe(h3);
  });
});

// ── LRU eviction ─────────────────────────────────────────────────────────

describe("LayerSwapper LRU eviction", () => {
  function clockMaker(start = 1) {
    let t = start;
    return () => t++;
  }

  it("evicts the least-recently-used slot when budget is exceeded", async () => {
    const events: LayerSwapperEvent[] = [];
    const sw = new LayerSwapper({
      budgetBytes: 500,
      clock: clockMaker(),
      onEvent: (e) => events.push(e),
    });
    const a = makeSpec("a", 200);
    const b = makeSpec("b", 200);
    const c = makeSpec("c", 200);

    await sw.acquire(a);
    await sw.acquire(b);
    // a is older than b → a should be evicted to fit c.
    await sw.acquire(c);
    await flush();

    const status = sw.status();
    const ids = status.slots.map((s) => s.id).sort();
    expect(ids).toEqual(["b", "c"]);
    expect(a.dispose).toHaveBeenCalledTimes(1);
    expect(b.dispose).not.toHaveBeenCalled();

    const lru = events.find(
      (e) => e.type === "slot-released" && e.id === "a",
    );
    expect(lru).toMatchObject({ reason: "lru", bytes: 200 });
  });

  it("touch() bumps recency so the touched slot survives the next eviction", async () => {
    const sw = new LayerSwapper({ budgetBytes: 500, clock: clockMaker() });
    const a = makeSpec("a", 200);
    const b = makeSpec("b", 200);
    const c = makeSpec("c", 200);

    await sw.acquire(a);
    await sw.acquire(b);
    sw.touch("a"); // a is now newest → b becomes LRU
    await sw.acquire(c);
    await flush();

    const ids = sw.status().slots.map((s) => s.id).sort();
    expect(ids).toEqual(["a", "c"]);
    expect(b.dispose).toHaveBeenCalledTimes(1);
  });

  it("touch() is a no-op for unknown ids", () => {
    const sw = new LayerSwapper({ budgetBytes: 1000 });
    expect(() => sw.touch("nope")).not.toThrow();
  });

  it("never evicts pinned slots; throws when no non-pinned victims fit", async () => {
    const events: LayerSwapperEvent[] = [];
    const sw = new LayerSwapper({
      budgetBytes: 500,
      clock: clockMaker(),
      onEvent: (e) => events.push(e),
    });
    await sw.acquire(makeSpec("p1", 200, { pinned: true }));
    await sw.acquire(makeSpec("p2", 200, { pinned: true }));
    // Only pinned residents left; new 200 B slot can't fit.
    await expect(sw.acquire(makeSpec("c", 200))).rejects.toThrow(/pinned/);
    expect(events).toContainEqual({
      type: "budget-exceeded",
      requestedBytes: 200,
      budgetBytes: 500,
    });
  });

  it("pinned slot survives LRU pressure while non-pinned ones are evicted", async () => {
    const sw = new LayerSwapper({ budgetBytes: 500, clock: clockMaker() });
    await sw.acquire(makeSpec("pinned-old", 200, { pinned: true }));
    await sw.acquire(makeSpec("normal", 200));
    await sw.acquire(makeSpec("new", 200));
    await flush();
    const ids = sw.status().slots.map((s) => s.id).sort();
    expect(ids).toEqual(["new", "pinned-old"]);
  });
});

// ── release / shutdown ───────────────────────────────────────────────────

describe("LayerSwapper release / shutdown", () => {
  it("release() disposes the slot and emits explicit reason", async () => {
    const events: LayerSwapperEvent[] = [];
    const sw = new LayerSwapper({
      budgetBytes: 1000,
      onEvent: (e) => events.push(e),
    });
    const spec = makeSpec("a", 200);
    await sw.acquire(spec);
    await sw.release("a");
    expect(spec.dispose).toHaveBeenCalledTimes(1);
    expect(events).toContainEqual({
      type: "slot-released",
      id: "a",
      bytes: 200,
      reason: "explicit",
    });
    expect(sw.status().slots).toHaveLength(0);
  });

  it("release() is safe for unknown ids", async () => {
    const sw = new LayerSwapper({ budgetBytes: 1000 });
    await expect(sw.release("nope")).resolves.toBeUndefined();
  });

  it("releaseAllSlots() leaves the base intact", async () => {
    const sw = new LayerSwapper({ budgetBytes: 1000 });
    const base = makeSpec("base", 100);
    await sw.pinBase(base);
    await sw.acquire(makeSpec("a", 100));
    await sw.acquire(makeSpec("b", 100));
    await sw.releaseAllSlots();
    expect(sw.status().slots).toHaveLength(0);
    expect(sw.status().baseId).toBe("base");
    expect(base.dispose).not.toHaveBeenCalled();
  });

  it("shutdown() disposes everything and rejects further calls", async () => {
    const events: LayerSwapperEvent[] = [];
    const sw = new LayerSwapper({
      budgetBytes: 1000,
      onEvent: (e) => events.push(e),
    });
    const base = makeSpec("base", 100);
    const a = makeSpec("a", 100);
    await sw.pinBase(base);
    await sw.acquire(a);
    await sw.shutdown();

    expect(base.dispose).toHaveBeenCalledTimes(1);
    expect(a.dispose).toHaveBeenCalledTimes(1);
    const shutdownReleases = events.filter(
      (e) => e.type === "slot-released" && e.reason === "shutdown",
    );
    expect(shutdownReleases).toHaveLength(2);

    await expect(sw.acquire(makeSpec("x", 1))).rejects.toThrow(/shut down/);
    await expect(sw.pinBase(makeSpec("y", 1))).rejects.toThrow(/shut down/);
  });

  it("shutdown() is idempotent", async () => {
    const sw = new LayerSwapper({ budgetBytes: 1000 });
    await sw.shutdown();
    await expect(sw.shutdown()).resolves.toBeUndefined();
  });

  it("dispose errors are swallowed and logged, never break bookkeeping", async () => {
    const sw = new LayerSwapper({ budgetBytes: 1000 });
    const spec = makeSpec("a", 200, {
      dispose: vi.fn(() => {
        throw new Error("disposer blew up");
      }),
    });
    await sw.acquire(spec);
    await expect(sw.release("a")).resolves.toBeUndefined();
    expect(sw.status().slots).toHaveLength(0);
  });
});

// ── status ───────────────────────────────────────────────────────────────

describe("LayerSwapper.status", () => {
  it("returns budget/base/slot accounting sorted by recency desc", async () => {
    let t = 10;
    const sw = new LayerSwapper({ budgetBytes: 1000, clock: () => t++ });
    await sw.pinBase(makeSpec("base", 100));
    await sw.acquire(makeSpec("old", 100));
    await sw.acquire(makeSpec("mid", 100));
    await sw.acquire(makeSpec("new", 100));
    const s = sw.status();
    expect(s.budgetBytes).toBe(1000);
    expect(s.baseBytes).toBe(100);
    expect(s.baseId).toBe("base");
    expect(s.totalBytes).toBe(400);
    expect(s.freeBytes).toBe(600);
    expect(s.slots.map((x) => x.id)).toEqual(["new", "mid", "old"]);
  });

  it("freeBytes never reports negative", async () => {
    // Force base = budget exactly; freeBytes should be 0.
    const sw = new LayerSwapper({ budgetBytes: 100 });
    await sw.pinBase(makeSpec("base", 100));
    expect(sw.status().freeBytes).toBe(0);
  });
});

// ── gbToBytes ────────────────────────────────────────────────────────────

describe("gbToBytes", () => {
  it("converts GB to bytes (1 GB = 2^30)", () => {
    expect(gbToBytes(1)).toBe(1024 * 1024 * 1024);
    expect(gbToBytes(2)).toBe(2 * 1024 * 1024 * 1024);
  });

  it("floors fractional GB", () => {
    expect(gbToBytes(0.5)).toBe(Math.floor(0.5 * 1024 * 1024 * 1024));
  });

  it("returns 0 for non-positive or non-finite inputs", () => {
    expect(gbToBytes(0)).toBe(0);
    expect(gbToBytes(-3)).toBe(0);
    expect(gbToBytes(Number.NaN)).toBe(0);
    expect(gbToBytes(Number.POSITIVE_INFINITY)).toBe(0);
  });
});
