/**
 * ContextSlotManager tests — IPLD slot lifecycle + DAG history + validation.
 *
 * Uses in-memory fakes for both the byte store and the registry so the
 * test suite never touches Helia or SQLite. CIDs are synthesised
 * deterministically from a sha256 of the encoded block bytes — good
 * enough to assert immutability + DAG linkage without needing a real
 * multiformats CID.
 */

import { createHash } from "node:crypto";
import { describe, expect, it, vi, beforeEach } from "vitest";

import * as dagCbor from "@ipld/dag-cbor";

import {
  ContextSlotManager,
  type ContextSlotEvent,
  type ContextSlotRegistry,
  type ContextSlotStore,
} from "../context_slots";

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

class FakeStore implements ContextSlotStore {
  blocks = new Map<string, Uint8Array>();
  pins = new Set<string>();
  putCalls = 0;
  getCalls = 0;
  pinCalls = 0;
  unpinCalls: string[] = [];

  async putBlock(bytes: Uint8Array): Promise<string> {
    this.putCalls++;
    const cid = `bafk${createHash("sha256").update(bytes).digest("hex").slice(0, 24)}`;
    this.blocks.set(cid, bytes);
    return cid;
  }
  async getBlock(cid: string): Promise<Uint8Array> {
    this.getCalls++;
    const v = this.blocks.get(cid);
    if (!v) throw new Error(`unknown cid: ${cid}`);
    return v;
  }
  async pin(cid: string): Promise<void> {
    this.pinCalls++;
    if (!this.blocks.has(cid)) throw new Error(`cannot pin unknown cid: ${cid}`);
    this.pins.add(cid);
  }
  async unpin(cid: string): Promise<void> {
    this.unpinCalls.push(cid);
    this.pins.delete(cid);
  }
}

class FakeRegistry implements ContextSlotRegistry {
  map = new Map<string, string | null>();
  async read(projectId: string): Promise<string | null> {
    return this.map.get(projectId) ?? null;
  }
  async write(projectId: string, cid: string | null): Promise<void> {
    this.map.set(projectId, cid);
  }
}

function makeManager(
  overrides: {
    onEvent?: (e: ContextSlotEvent) => void;
    now?: () => number;
  } = {},
) {
  const store = new FakeStore();
  const registry = new FakeRegistry();
  const events: ContextSlotEvent[] = [];
  const onEvent = overrides.onEvent ?? ((e) => events.push(e));
  const mgr = new ContextSlotManager({
    store,
    registry,
    onEvent,
    now: overrides.now,
  });
  return { mgr, store, registry, events };
}

const adapter = (s: string) => new TextEncoder().encode(s);

// ── constructor ──────────────────────────────────────────────────────────

describe("ContextSlotManager constructor", () => {
  it("rejects missing store / registry", () => {
    expect(
      () =>
        new ContextSlotManager({
          store: undefined as unknown as ContextSlotStore,
          registry: new FakeRegistry(),
        }),
    ).toThrow(/store/);
    expect(
      () =>
        new ContextSlotManager({
          store: new FakeStore(),
          registry: undefined as unknown as ContextSlotRegistry,
        }),
    ).toThrow(/registry/);
  });
});

// ── createSlot ───────────────────────────────────────────────────────────

describe("ContextSlotManager.createSlot", () => {
  it("encodes, pins, registers, and emits a created event", async () => {
    const { mgr, store, registry, events } = makeManager({ now: () => 100 });
    const { cid, block } = await mgr.createSlot({
      projectId: "1",
      baseModelId: "phi-3-mini-int4",
      adapterBytes: adapter("alpha"),
    });
    expect(cid).toMatch(/^bafk/);
    expect(store.pins.has(cid)).toBe(true);
    expect(await registry.read("1")).toBe(cid);
    expect(block.previousCid).toBe(null);
    expect(block.createdAtMs).toBe(100);
    expect(block.metadata).toEqual({});

    // Round-trip via dagCbor matches.
    const raw = store.blocks.get(cid)!;
    const decoded = dagCbor.decode<Record<string, unknown>>(raw);
    expect(decoded.version).toBe(1);
    expect(decoded.projectId).toBe("1");
    expect(decoded.baseModelId).toBe("phi-3-mini-int4");

    expect(events).toHaveLength(1);
    const ev = events[0];
    expect(ev.type).toBe("created");
    if (ev.type !== "created") throw new Error("unreachable");
    expect(ev.adapterBytes).toBe(5);
    expect(ev.blockBytes).toBe(raw.byteLength);
  });

  it("rejects empty / invalid inputs", async () => {
    const { mgr } = makeManager();
    await expect(
      mgr.createSlot({
        projectId: "",
        baseModelId: "phi",
        adapterBytes: adapter("x"),
      }),
    ).rejects.toThrow(/projectId/);
    await expect(
      mgr.createSlot({
        projectId: "1",
        baseModelId: "",
        adapterBytes: adapter("x"),
      }),
    ).rejects.toThrow(/baseModelId/);
    await expect(
      mgr.createSlot({
        projectId: "1",
        baseModelId: "phi",
        adapterBytes: new Uint8Array(0),
      }),
    ).rejects.toThrow(/adapterBytes/);
  });

  it("refuses to create over an existing slot", async () => {
    const { mgr } = makeManager();
    await mgr.createSlot({
      projectId: "1",
      baseModelId: "phi",
      adapterBytes: adapter("a"),
    });
    await expect(
      mgr.createSlot({
        projectId: "1",
        baseModelId: "phi",
        adapterBytes: adapter("b"),
      }),
    ).rejects.toThrow(/already has a context slot/);
  });

  it("persists metadata when provided", async () => {
    const { mgr, store } = makeManager();
    const { cid } = await mgr.createSlot({
      projectId: "1",
      baseModelId: "phi",
      adapterBytes: adapter("a"),
      metadata: { distillationReceiptId: "rcpt-7", finalLoss: 0.42 },
    });
    const decoded = dagCbor.decode<{ metadata: Record<string, unknown> }>(
      store.blocks.get(cid)!,
    );
    expect(decoded.metadata).toEqual({
      distillationReceiptId: "rcpt-7",
      finalLoss: 0.42,
    });
  });
});

// ── loadSlot ─────────────────────────────────────────────────────────────

describe("ContextSlotManager.loadSlot", () => {
  it("returns null when the project has no slot yet", async () => {
    const { mgr, events } = makeManager();
    const res = await mgr.loadSlot("1");
    expect(res).toBe(null);
    expect(events).toHaveLength(0);
  });

  it("fetches + decodes the current head slot and emits loaded", async () => {
    let t = 1000;
    const { mgr, events } = makeManager({ now: () => t++ });
    const { cid } = await mgr.createSlot({
      projectId: "1",
      baseModelId: "phi",
      adapterBytes: adapter("hello"),
    });
    const got = await mgr.loadSlot("1");
    expect(got).not.toBe(null);
    if (!got) throw new Error("unreachable");
    expect(got.cid).toBe(cid);
    expect(new TextDecoder().decode(got.block.adapterBytes)).toBe("hello");

    const loaded = events.find((e) => e.type === "loaded");
    expect(loaded).toBeDefined();
    if (loaded?.type !== "loaded") throw new Error("unreachable");
    expect(loaded.projectId).toBe("1");
    expect(loaded.loadDurationMs).toBeGreaterThanOrEqual(0);
  });

  it("throws when the decoded block targets a different project", async () => {
    const { mgr, store, registry } = makeManager();
    // Forge a block claiming projectId=2 and point project 1 at it.
    const forged = dagCbor.encode({
      version: 1,
      projectId: "2",
      baseModelId: "phi",
      adapterBytes: adapter("x"),
      metadata: {},
      previousCid: null,
      createdAtMs: 1,
    });
    const cid = await store.putBlock(forged);
    await registry.write("1", cid);
    await expect(mgr.loadSlot("1")).rejects.toThrow(/belongs to project 2/);
  });

  it("rejects empty projectId", async () => {
    const { mgr } = makeManager();
    await expect(mgr.loadSlot("")).rejects.toThrow(/projectId/);
  });

  it("rejects blocks with an unsupported version", async () => {
    const { mgr, store, registry } = makeManager();
    const forged = dagCbor.encode({
      version: 99,
      projectId: "1",
      baseModelId: "phi",
      adapterBytes: adapter("x"),
      metadata: {},
      previousCid: null,
      createdAtMs: 1,
    });
    const cid = await store.putBlock(forged);
    await registry.write("1", cid);
    await expect(mgr.loadSlot("1")).rejects.toThrow(/version: 99/);
  });

  it("rejects blocks that fail schema validation", async () => {
    const { mgr, store, registry } = makeManager();
    const forged = dagCbor.encode({
      version: 1,
      projectId: 1, // wrong type
      baseModelId: "phi",
      adapterBytes: adapter("x"),
      metadata: {},
      previousCid: null,
      createdAtMs: 1,
    });
    const cid = await store.putBlock(forged);
    await registry.write("1", cid);
    await expect(mgr.loadSlot("1")).rejects.toThrow(/schema validation/);
  });
});

// ── updateSlot ───────────────────────────────────────────────────────────

describe("ContextSlotManager.updateSlot", () => {
  it("appends a child slot pointing at the previous CID", async () => {
    const { mgr, store, registry, events } = makeManager();
    const root = await mgr.createSlot({
      projectId: "1",
      baseModelId: "phi",
      adapterBytes: adapter("v1"),
    });
    const child = await mgr.updateSlot({
      projectId: "1",
      baseModelId: "phi",
      adapterBytes: adapter("v2"),
    });
    expect(child.cid).not.toBe(root.cid);
    expect(child.block.previousCid).toBe(root.cid);
    expect(await registry.read("1")).toBe(child.cid);
    expect(store.pins.has(child.cid)).toBe(true);

    const updated = events.find((e) => e.type === "updated");
    expect(updated).toBeDefined();
    if (updated?.type !== "updated") throw new Error("unreachable");
    expect(updated.previousCid).toBe(root.cid);
  });

  it("refuses to update when no slot exists", async () => {
    const { mgr } = makeManager();
    await expect(
      mgr.updateSlot({
        projectId: "1",
        baseModelId: "phi",
        adapterBytes: adapter("v1"),
      }),
    ).rejects.toThrow(/no context slot yet/);
  });

  it("validates inputs like createSlot does", async () => {
    const { mgr } = makeManager();
    await mgr.createSlot({
      projectId: "1",
      baseModelId: "phi",
      adapterBytes: adapter("v1"),
    });
    await expect(
      mgr.updateSlot({
        projectId: "1",
        baseModelId: "phi",
        adapterBytes: new Uint8Array(0),
      }),
    ).rejects.toThrow(/adapterBytes/);
  });
});

// ── clearSlot ────────────────────────────────────────────────────────────

describe("ContextSlotManager.clearSlot", () => {
  it("detaches the registry pointer but leaves the block + pin intact", async () => {
    const { mgr, store, registry, events } = makeManager();
    const { cid } = await mgr.createSlot({
      projectId: "1",
      baseModelId: "phi",
      adapterBytes: adapter("v1"),
    });
    await mgr.clearSlot("1");
    expect(await registry.read("1")).toBe(null);
    expect(store.blocks.has(cid)).toBe(true);
    expect(store.pins.has(cid)).toBe(true);

    const cleared = events.find((e) => e.type === "cleared");
    expect(cleared).toBeDefined();
    if (cleared?.type !== "cleared") throw new Error("unreachable");
    expect(cleared.previousCid).toBe(cid);
  });

  it("is a no-op when nothing is attached", async () => {
    const { mgr, events } = makeManager();
    await mgr.clearSlot("1");
    expect(events).toHaveLength(0);
  });
});

// ── history (Merkle DAG walk) ────────────────────────────────────────────

describe("ContextSlotManager.history", () => {
  it("yields slots newest-first walking previousCid", async () => {
    const { mgr } = makeManager();
    const root = await mgr.createSlot({
      projectId: "1",
      baseModelId: "phi",
      adapterBytes: adapter("a"),
    });
    const mid = await mgr.updateSlot({
      projectId: "1",
      baseModelId: "phi",
      adapterBytes: adapter("b"),
    });
    const head = await mgr.updateSlot({
      projectId: "1",
      baseModelId: "phi",
      adapterBytes: adapter("c"),
    });
    const cids: string[] = [];
    for await (const entry of mgr.history("1")) cids.push(entry.cid);
    expect(cids).toEqual([head.cid, mid.cid, root.cid]);
  });

  it("yields nothing for a project with no slot", async () => {
    const { mgr } = makeManager();
    const cids: string[] = [];
    for await (const entry of mgr.history("1")) cids.push(entry.cid);
    expect(cids).toEqual([]);
  });

  it("detects DAG cycles defensively", async () => {
    const { mgr, store, registry } = makeManager();
    // Hand-craft a block that points at itself.
    const placeholder = dagCbor.encode({
      version: 1,
      projectId: "1",
      baseModelId: "phi",
      adapterBytes: adapter("a"),
      metadata: {},
      previousCid: "self-cid",
      createdAtMs: 1,
    });
    const cid = await store.putBlock(placeholder);
    // Force previousCid === cid by patching the in-memory entry.
    const cyclic = dagCbor.encode({
      version: 1,
      projectId: "1",
      baseModelId: "phi",
      adapterBytes: adapter("a"),
      metadata: {},
      previousCid: cid,
      createdAtMs: 2,
    });
    store.blocks.set(cid, cyclic);
    await registry.write("1", cid);
    await expect(async () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of mgr.history("1")) {
        /* drain */
      }
    }).rejects.toThrow(/cycle detected/);
  });
});

// ── events ───────────────────────────────────────────────────────────────

describe("ContextSlotManager event emission", () => {
  it("swallows subscriber throws so the caller flow is unaffected", async () => {
    const onEvent = vi.fn(() => {
      throw new Error("subscriber blew up");
    });
    const { mgr, registry } = makeManager({ onEvent });
    await expect(
      mgr.createSlot({
        projectId: "1",
        baseModelId: "phi",
        adapterBytes: adapter("x"),
      }),
    ).resolves.toBeDefined();
    expect(await registry.read("1")).toMatch(/^bafk/);
    expect(onEvent).toHaveBeenCalled();
  });

  it("never invokes onEvent when not provided", async () => {
    const store = new FakeStore();
    const registry = new FakeRegistry();
    const mgr = new ContextSlotManager({ store, registry });
    await expect(
      mgr.createSlot({
        projectId: "1",
        baseModelId: "phi",
        adapterBytes: adapter("x"),
      }),
    ).resolves.toBeDefined();
  });
});

// ── deterministic CIDs ───────────────────────────────────────────────────

describe("ContextSlotManager determinism", () => {
  it("produces identical CIDs for identical block content", async () => {
    const a = makeManager({ now: () => 1 });
    const b = makeManager({ now: () => 1 });
    const r1 = await a.mgr.createSlot({
      projectId: "1",
      baseModelId: "phi",
      adapterBytes: adapter("same"),
    });
    const r2 = await b.mgr.createSlot({
      projectId: "1",
      baseModelId: "phi",
      adapterBytes: adapter("same"),
    });
    expect(r1.cid).toBe(r2.cid);
  });

  it("produces different CIDs when only the timestamp changes", async () => {
    const a = makeManager({ now: () => 1 });
    const b = makeManager({ now: () => 2 });
    const r1 = await a.mgr.createSlot({
      projectId: "1",
      baseModelId: "phi",
      adapterBytes: adapter("same"),
    });
    const r2 = await b.mgr.createSlot({
      projectId: "1",
      baseModelId: "phi",
      adapterBytes: adapter("same"),
    });
    expect(r1.cid).not.toBe(r2.cid);
  });
});

// ── pruneHistory ─────────────────────────────────────────────────────────

describe("ContextSlotManager.pruneHistory", () => {
  async function seedChain(
    mgr: ContextSlotManager,
    count: number,
    publishedIdx: number[] = [],
  ) {
    let now = 0;
    // First slot
    await mgr.createSlot({
      projectId: "1",
      baseModelId: "phi",
      adapterBytes: adapter(`v0`),
      metadata: publishedIdx.includes(0) ? { published: true } : {},
    });
    for (let i = 1; i < count; i++) {
      now += 1;
      await mgr.updateSlot({
        projectId: "1",
        baseModelId: "phi",
        adapterBytes: adapter(`v${i}`),
        metadata: publishedIdx.includes(i) ? { published: true } : {},
      });
    }
    void now;
  }

  it("keeps the last N (default 10) and unpins the rest", async () => {
    const { mgr, store } = makeManager();
    await seedChain(mgr, 13);
    const res = await mgr.pruneHistory("1");
    expect(res.keptCids.length).toBe(10);
    expect(res.prunedCids.length).toBe(3);
    expect(store.unpinCalls.length).toBe(3);
    // Pruned CIDs are the *oldest* (last in newest-first iteration).
    expect(new Set(res.prunedCids).size).toBe(3);
  });

  it("respects explicit keepLast", async () => {
    const { mgr, store } = makeManager();
    await seedChain(mgr, 6);
    const res = await mgr.pruneHistory("1", { keepLast: 2 });
    expect(res.keptCids.length).toBe(2);
    expect(res.prunedCids.length).toBe(4);
    expect(store.unpinCalls.length).toBe(4);
  });

  it("always preserves published slots even when older than keepLast", async () => {
    const { mgr, store } = makeManager();
    // 6 slots; index 0 (oldest) is published.
    await seedChain(mgr, 6, [0]);
    const res = await mgr.pruneHistory("1", { keepLast: 2 });
    expect(res.keptCids.length).toBe(3); // 2 recent + 1 published
    expect(res.prunedCids.length).toBe(3);
    expect(store.unpinCalls.length).toBe(3);
  });

  it("emits a 'pruned' event with kept/pruned CIDs", async () => {
    const { mgr, events } = makeManager();
    await seedChain(mgr, 5);
    const res = await mgr.pruneHistory("1", { keepLast: 2 });
    const pruned = events.find((e) => e.type === "pruned");
    expect(pruned).toBeDefined();
    expect(pruned).toMatchObject({
      type: "pruned",
      projectId: "1",
      unpinned: true,
    });
    expect((pruned as { keptCids: string[] }).keptCids).toEqual(res.keptCids);
    expect((pruned as { prunedCids: string[] }).prunedCids).toEqual(
      res.prunedCids,
    );
  });

  it("is a no-op for projects with no slots", async () => {
    const { mgr, store } = makeManager();
    const res = await mgr.pruneHistory("never-existed");
    expect(res.keptCids).toEqual([]);
    expect(res.prunedCids).toEqual([]);
    expect(store.unpinCalls.length).toBe(0);
  });

  it("emits unpinned=false when the store doesn't support unpin", async () => {
    const store = new FakeStore();
    // Remove unpin to simulate a store that can't release pins.
    (store as unknown as { unpin?: unknown }).unpin = undefined;
    const registry = new FakeRegistry();
    const events: ContextSlotEvent[] = [];
    const mgr = new ContextSlotManager({
      store,
      registry,
      onEvent: (e) => events.push(e),
    });
    await seedChain(mgr, 5);
    const res = await mgr.pruneHistory("1", { keepLast: 2 });
    expect(res.prunedCids.length).toBe(3);
    expect(store.unpinCalls.length).toBe(0);
    const pruned = events.find((e) => e.type === "pruned") as {
      type: "pruned";
      unpinned: boolean;
    };
    expect(pruned.unpinned).toBe(false);
  });

  it("logs and continues when individual unpin calls throw", async () => {
    const { mgr, store } = makeManager();
    await seedChain(mgr, 5);
    const realUnpin = store.unpin.bind(store);
    let n = 0;
    store.unpin = async (cid: string) => {
      n += 1;
      if (n === 1) throw new Error("transient");
      return realUnpin(cid);
    };
    const res = await mgr.pruneHistory("1", { keepLast: 2 });
    expect(res.prunedCids.length).toBe(3);
    // Two of three unpins succeeded.
    expect(store.pins.size).toBe(5 - 2);
  });
});
