/**
 * OnnxRuntimeRenderer client tests.
 *
 * Uses a controllable `FakeWorker` so we can drive the protocol from the
 * test side and verify routing, idempotency, error propagation, chunk
 * forwarding, and shutdown semantics — none of which require a real worker.
 */

import { describe, expect, it, beforeEach } from "vitest";

import { OnnxRuntimeRenderer } from "../onnx_runtime_renderer";

interface OutboundMessage {
  type: string;
  id: number;
  payload?: unknown;
  error?: string;
}

class FakeWorker {
  static instances: FakeWorker[] = [];
  private listeners = new Map<string, Array<(e: MessageEvent | ErrorEvent) => void>>();
  posted: Array<{ type: string; id: number; payload?: unknown }> = [];
  terminated = false;
  _initReplied = false;
  _loadReplied = false;

  constructor() {
    FakeWorker.instances.push(this);
  }

  addEventListener(event: string, fn: (e: MessageEvent | ErrorEvent) => void) {
    const list = this.listeners.get(event) ?? [];
    list.push(fn);
    this.listeners.set(event, list);
  }

  postMessage(m: { type: string; id: number; payload?: unknown }) {
    this.posted.push(m);
  }

  terminate() {
    this.terminated = true;
  }

  emit(msg: OutboundMessage) {
    const list = this.listeners.get("message") ?? [];
    for (const fn of list) fn({ data: msg } as MessageEvent);
  }

  emitError(message: string) {
    const list = this.listeners.get("error") ?? [];
    for (const fn of list) fn({ message } as ErrorEvent);
  }
}

beforeEach(() => {
  FakeWorker.instances = [];
});

function makeClient() {
  return new OnnxRuntimeRenderer({
    hfRepo: "test/repo",
    dtype: "q4",
    workerFactory: () => new FakeWorker() as unknown as Worker,
  });
}

/** Flush microtasks several times so chained awaits can progress. */
async function flush(n = 10) {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

/** Reply to init + load-base as they appear, then optionally to infer. */
async function drainSetup(
  w: FakeWorker,
  inferReply?: (id: number) => void,
) {
  for (let i = 0; i < 20; i++) {
    await flush();
    const initMsg = w.posted.find((m) => m.type === "init");
    if (initMsg && !w._initReplied) {
      w.emit({ type: "init:ok", id: initMsg.id });
      w._initReplied = true;
    }
    const loadMsg = w.posted.find((m) => m.type === "load-base");
    if (loadMsg && !w._loadReplied) {
      w.emit({ type: "load-base:ok", id: loadMsg.id, payload: { loadDurationMs: 1 } });
      w._loadReplied = true;
    }
    const inferMsg = w.posted.find((m) => m.type === "infer");
    if (inferMsg && inferReply) {
      inferReply(inferMsg.id);
      return;
    }
    if (!inferReply && w._initReplied && w._loadReplied) return;
  }
}

describe("OnnxRuntimeRenderer", () => {
  it("sends init then load-base then infer, in order", async () => {
    const c = makeClient();
    const p = c.infer({ prompt: "hi" });
    const w = FakeWorker.instances[0];
    expect(w).toBeDefined();

    await drainSetup(w, (id) =>
      w.emit({
        type: "infer:ok",
        id,
        payload: { text: "hello", tokensIn: 1, tokensOut: 1, durationMs: 5, executionProvider: "auto" },
      }),
    );

    const res = await p;
    expect(res.text).toBe("hello");
    expect(res.usedShardStream).toBe(false);
    expect(w.posted.map((m) => m.type)).toEqual(["init", "load-base", "infer"]);
    expect(w.posted.find((m) => m.type === "load-base")!.payload).toEqual({
      hfRepo: "test/repo",
      dtype: "q4",
    });
    expect(w.posted.find((m) => m.type === "infer")!.payload).toMatchObject({
      prompt: "hi",
      stream: false,
    });
  });

  it("does not re-send init/load-base on subsequent inferences", async () => {
    const c = makeClient();
    const p1 = c.infer({ prompt: "a" });
    const w = FakeWorker.instances[0];
    await drainSetup(w, (id) =>
      w.emit({
        type: "infer:ok",
        id,
        payload: { text: "1", tokensIn: 1, tokensOut: 1, durationMs: 1, executionProvider: "auto" },
      }),
    );
    await p1;

    const before = w.posted.length;
    const p2 = c.infer({ prompt: "b" });
    await flush();
    expect(w.posted.length - before).toBe(1);
    const m2 = w.posted[w.posted.length - 1];
    expect(m2.type).toBe("infer");
    w.emit({
      type: "infer:ok",
      id: m2.id,
      payload: { text: "2", tokensIn: 1, tokensOut: 1, durationMs: 1, executionProvider: "auto" },
    });
    expect((await p2).text).toBe("2");
  });

  it("rejects when prompt is empty", async () => {
    const c = makeClient();
    await expect(c.infer({ prompt: "" })).rejects.toThrow(/prompt is required/);
    await expect(c.streamInfer({ prompt: "" }, () => {})).rejects.toThrow(
      /prompt is required/,
    );
  });

  it("forwards streaming chunks via onChunk and resolves with final response", async () => {
    const c = makeClient();
    const chunks: string[] = [];
    const p = c.streamInfer({ prompt: "hi" }, (ch) => chunks.push(ch));
    const w = FakeWorker.instances[0];
    await drainSetup(w, (id) => {
      w.emit({ type: "infer:chunk", id, payload: { chunk: "he" } });
      w.emit({ type: "infer:chunk", id, payload: { chunk: "llo" } });
      w.emit({
        type: "infer:ok",
        id,
        payload: { text: "hello", tokensIn: 1, tokensOut: 2, durationMs: 3, executionProvider: "auto" },
      });
    });
    const res = await p;
    expect(chunks).toEqual(["he", "llo"]);
    expect(res.tokensOut).toBe(2);
    expect(w.posted.find((m) => m.type === "infer")!.payload).toMatchObject({
      stream: true,
    });
  });

  it("propagates error envelopes as rejected promises", async () => {
    const c = makeClient();
    const p = c.init();
    const w = FakeWorker.instances[0];
    await flush();
    const initMsg = w.posted.find((m) => m.type === "init")!;
    w.emit({ type: "error", id: initMsg.id, error: "boom" });
    await expect(p).rejects.toThrow(/boom/);
  });

  it("isolates throwing chunk handlers", async () => {
    const c = makeClient();
    const p = c.streamInfer({ prompt: "hi" }, () => {
      throw new Error("subscriber blew up");
    });
    const w = FakeWorker.instances[0];
    await drainSetup(w, (id) => {
      w.emit({ type: "infer:chunk", id, payload: { chunk: "x" } });
      w.emit({
        type: "infer:ok",
        id,
        payload: { text: "x", tokensIn: 0, tokensOut: 1, durationMs: 1, executionProvider: "auto" },
      });
    });
    await expect(p).resolves.toBeDefined();
  });

  it("worker 'error' event rejects all pending requests", async () => {
    const c = makeClient();
    const p1 = c.init();
    const w = FakeWorker.instances[0];
    w.emitError("worker died");
    await expect(p1).rejects.toThrow(/crashed/);
  });

  it("shutdown terminates the worker and rejects subsequent calls", async () => {
    const c = makeClient();
    const initP = c.init();
    const w = FakeWorker.instances[0];
    await flush();
    w.emit({
      type: "init:ok",
      id: w.posted.find((m) => m.type === "init")!.id,
    });
    await initP;

    const downP = c.shutdown();
    await flush();
    const downMsg = w.posted.find((m) => m.type === "shutdown")!;
    w.emit({ type: "shutdown:ok", id: downMsg.id });
    await downP;
    expect(w.terminated).toBe(true);
    await expect(c.infer({ prompt: "hi" })).rejects.toThrow(/shut down/);
  });

  it("shutdown rejects in-flight pending requests", async () => {
    const c = makeClient();
    const initP = c.init();
    const w = FakeWorker.instances[0];
    await flush();
    w.emit({
      type: "init:ok",
      id: w.posted.find((m) => m.type === "init")!.id,
    });
    await initP;

    const stuck = c.loadBase();
    await flush();
    expect(w.posted.some((m) => m.type === "load-base")).toBe(true);

    const downP = c.shutdown();
    await flush();
    const downMsg = w.posted.find((m) => m.type === "shutdown")!;
    w.emit({ type: "shutdown:ok", id: downMsg.id });
    await downP;

    await expect(stuck).rejects.toThrow(/shut down/);
  });
});
