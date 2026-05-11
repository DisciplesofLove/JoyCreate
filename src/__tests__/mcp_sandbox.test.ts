import { describe, it, expect, vi, beforeEach } from "vitest";
import { computeInvocationHash } from "@/lib/mcp_sandbox/hash";

describe("computeInvocationHash", () => {
  it("returns a 64-char lowercase hex string", () => {
    const h = computeInvocationHash({
      serverName: "filesystem",
      toolName: "read_file",
      args: { path: "C:/x.txt" },
    });
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic regardless of arg key order", () => {
    const a = computeInvocationHash({
      serverName: "fs",
      toolName: "list",
      args: { path: "/", limit: 10 },
    });
    const b = computeInvocationHash({
      serverName: "fs",
      toolName: "list",
      args: { limit: 10, path: "/" },
    });
    expect(a).toBe(b);
  });

  it("differs on any field change", () => {
    const base = computeInvocationHash({
      serverName: "s",
      toolName: "t",
      args: { a: 1 },
    });
    expect(
      computeInvocationHash({ serverName: "s2", toolName: "t", args: { a: 1 } }),
    ).not.toBe(base);
    expect(
      computeInvocationHash({ serverName: "s", toolName: "t2", args: { a: 1 } }),
    ).not.toBe(base);
    expect(
      computeInvocationHash({ serverName: "s", toolName: "t", args: { a: 2 } }),
    ).not.toBe(base);
  });

  it("treats null and missing args identically", () => {
    const a = computeInvocationHash({
      serverName: "s",
      toolName: "t",
      args: null,
    });
    const b = computeInvocationHash({
      serverName: "s",
      toolName: "t",
      args: undefined,
    });
    expect(a).toBe(b);
  });
});

// Mock the database before importing policy.
vi.mock("@/db", () => {
  const allowlistRows: Array<Record<string, unknown>> = [];
  const auditRows: Array<Record<string, unknown>> = [];
  const chain = (rows: Array<Record<string, unknown>>) => {
    const obj: Record<string, unknown> = {};
    obj.from = () => obj;
    obj.where = () => obj;
    obj.orderBy = () => obj;
    obj.limit = () => Promise.resolve(rows);
    obj.values = (v: Record<string, unknown>) => {
      rows.push({ id: rows.length + 1, ...v });
      return Promise.resolve();
    };
    obj.set = () => obj;
    return obj;
  };
  const db = {
    select: () => chain(allowlistRows),
    insert: (table: { _name?: string }) => {
      // route by table name guess
      return chain(
        (table as unknown as { _name: string })._name === "audit"
          ? auditRows
          : allowlistRows,
      );
    },
    update: () => chain(allowlistRows),
    delete: () => chain(allowlistRows),
    _allowlistRows: allowlistRows,
    _auditRows: auditRows,
  };
  return { getDb: () => db };
});

vi.mock("@/db/schema", () => ({
  whitehatMcpAllowlist: { _name: "allowlist" },
  whitehatMcpAudit: { _name: "audit" },
}));

vi.mock("drizzle-orm", () => ({
  eq: () => undefined,
  and: () => undefined,
  desc: () => undefined,
}));

describe("policy.evaluate (default-deny)", () => {
  let policy: typeof import("@/lib/mcp_sandbox/policy");
  beforeEach(async () => {
    vi.resetModules();
    policy = await import("@/lib/mcp_sandbox/policy");
    policy._resetForTests();
  });

  it("denies when no allowlist match and no interactive prompt", async () => {
    const result = await policy.evaluate(
      { serverName: "fs", toolName: "read_file", args: { path: "/x" } },
      "rpc-1",
    );
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("no allowlist");
    expect(result.invocationHash).toMatch(/^[0-9a-f]{64}$/);
  });
});
