/**
 * The audit log is a security surface, so the two things that matter are that a
 * filter actually narrows the result and that an export cannot be misread.
 *
 * Both were wrong in the code this replaces. The existing networked reader
 * (`jcn:admin:auditLog`) chains `.where()` calls, and in Drizzle each call
 * *replaces* the previous clause rather than ANDing it — so asking for "config
 * changes since Monday" silently applied only the date. And the page had no
 * export at all; the button raised a toast.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

const { rows, registry } = vi.hoisted(() => ({
  rows: [] as any[],
  registry: new Map<string, (...a: any[]) => any>(),
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

vi.mock("./safe_handle", () => ({}));
vi.mock("@/ipc/handlers/safe_handle", () => ({
  createLoggedHandler: () => (channel: string, fn: (...a: any[]) => any) =>
    registry.set(channel, fn),
}));

// Predicate-based fake: `where` receives the composed clause and applies it, so
// a filter that fails to narrow shows up as extra rows rather than as a passing
// assertion about a query object nobody ran.
vi.mock("drizzle-orm", () => {
  type P = (r: any) => boolean;
  return {
    eq: (c: any, v: any): P => (r) => r[c] === v,
    gte: (c: any, v: any): P => (r) => new Date(r[c]) >= new Date(v),
    lte: (c: any, v: any): P => (r) => new Date(r[c]) <= new Date(v),
    like: (c: any, v: string): P => {
      const needle = v.replace(/%/g, "").toLowerCase();
      return (r) => String(r[c] ?? "").toLowerCase().includes(needle);
    },
    and:
      (...ps: P[]): P =>
      (r) => ps.every((p) => !p || p(r)),
    or:
      (...ps: P[]): P =>
      (r) => ps.some((p) => p && p(r)),
    desc: (c: any) => c,
  };
});

vi.mock("@/db/schema", () => ({
  jcnAuditLog: {
    id: "id",
    timestamp: "timestamp",
    action: "action",
    actorType: "actorType",
    actorId: "actorId",
    actorWallet: "actorWallet",
    targetType: "targetType",
    targetId: "targetId",
    requestId: "requestId",
    traceId: "traceId",
  },
}));

vi.mock("@/db", () => ({
  getDb: () => ({
    select: (_cols?: any) => ({
      from: () => {
        let pred: ((r: any) => boolean) | undefined;
        let lim = Infinity;
        let off = 0;
        const api: any = {
          where: (p?: any) => {
            pred = p;
            return api;
          },
          orderBy: () => api,
          limit: (n: number) => {
            lim = n;
            return api;
          },
          offset: (n: number) => {
            off = n;
            return api;
          },
          then: (res: any, rej: any) => {
            const out = (pred ? rows.filter(pred) : [...rows]).slice(off, off + lim);
            return Promise.resolve(out).then(res, rej);
          },
        };
        return api;
      },
    }),
  }),
}));

import { registerAuditHandlers } from "@/ipc/handlers/audit_handlers";

function seed(...entries: Array<Partial<Record<string, unknown>>>) {
  rows.length = 0;
  entries.forEach((e, i) =>
    rows.push({
      id: `row-${i}`,
      timestamp: new Date("2026-01-0" + ((i % 8) + 1)),
      action: "did.something",
      actorType: "user",
      actorId: "terry",
      actorWallet: null,
      targetType: "config",
      targetId: "settings",
      requestId: null,
      traceId: null,
      ...e,
    }),
  );
}

const call = (channel: string, params?: unknown) =>
  registry.get(channel)!({}, params);

beforeEach(() => {
  registry.clear();
  rows.length = 0;
  registerAuditHandlers();
});

describe("querying", () => {
  it("registers the read channels", () => {
    expect([...registry.keys()].sort()).toEqual([
      "audit:export",
      "audit:query",
      "audit:stats",
    ]);
  });

  it("returns everything when unfiltered", async () => {
    seed({}, {}, {});
    expect(await call("audit:query", {})).toHaveLength(3);
  });

  it("ANDs filters instead of letting the last one win", async () => {
    // The defect this exists to prevent: two filters where only one applied.
    seed(
      { actorType: "user", targetType: "config" },
      { actorType: "admin", targetType: "config" },
      { actorType: "user", targetType: "key" },
    );

    const out = await call("audit:query", {
      actorType: "user",
      targetType: "config",
    });

    expect(out).toHaveLength(1);
    expect(out[0].actorType).toBe("user");
    expect(out[0].targetType).toBe("config");
  });

  it("searches across action, actor and target together", async () => {
    seed(
      { action: "key.rotated", actorId: "system" },
      { action: "config.saved", actorId: "terry" },
      { action: "publish.started", targetId: "my-key-store" },
    );

    const out = await call("audit:query", { search: "key" });
    // Matches the action of the first and the targetId of the third, not the
    // second — an OR across fields, ANDed with everything else.
    expect(out.map((r: any) => r.id).sort()).toEqual(["row-0", "row-2"]);
  });

  it("returns timestamps as ISO strings the renderer can parse", async () => {
    seed({});
    const [row] = await call("audit:query", {});
    expect(typeof row.timestamp).toBe("string");
    expect(new Date(row.timestamp).getUTCFullYear()).toBe(2026);
  });

  it("clamps an absurd limit rather than reading the whole table", async () => {
    seed(...Array.from({ length: 50 }, () => ({})));
    const out = await call("audit:query", { limit: 10_000_000 });
    expect(out.length).toBeLessThanOrEqual(2000);
  });
});

describe("stats", () => {
  it("counts by actor and target and reports the range", async () => {
    seed(
      { actorType: "user", targetType: "config", timestamp: new Date("2026-01-01") },
      { actorType: "user", targetType: "key", timestamp: new Date("2026-01-05") },
      { actorType: "system", targetType: "key", timestamp: new Date("2026-01-03") },
    );

    const s = await call("audit:stats");

    expect(s.total).toBe(3);
    expect(s.byActor).toEqual({ user: 2, system: 1 });
    expect(s.byTarget).toEqual({ config: 1, key: 2 });
    expect(s.newest).toContain("2026-01-05");
    expect(s.oldest).toContain("2026-01-01");
  });
});

describe("exporting", () => {
  it("writes a CSV header and one row per entry", async () => {
    seed({}, {});
    const out = await call("audit:export", { format: "csv" });

    const lines = out.content.split("\n");
    expect(out.rowCount).toBe(2);
    expect(lines[0]).toContain("timestamp,action,actorType");
    expect(lines).toHaveLength(3);
  });

  it("quotes fields so a comma cannot shift every later column", async () => {
    // An action containing a comma would otherwise corrupt the export silently
    // — noticed only when it is being read as evidence.
    seed({ action: "deleted key, rotated secret" });
    const out = await call("audit:export", { format: "csv" });
    expect(out.content).toContain('"deleted key, rotated secret"');
    expect(out.content.split("\n")).toHaveLength(2);
  });

  it("doubles embedded quotes rather than ending the field early", async () => {
    seed({ action: 'set name to "prod"' });
    const out = await call("audit:export", { format: "csv" });
    expect(out.content).toContain('"set name to ""prod"""');
  });

  it("exports the filtered set, not everything", async () => {
    seed(
      { actorType: "user" },
      { actorType: "system" },
      { actorType: "system" },
    );
    const out = await call("audit:export", { actorType: "system", format: "csv" });
    expect(out.rowCount).toBe(2);
  });

  it("emits parseable JSON when asked for it", async () => {
    seed({ action: "key.rotated" });
    const out = await call("audit:export", { format: "json" });
    const parsed = JSON.parse(out.content);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].action).toBe("key.rotated");
  });
});
