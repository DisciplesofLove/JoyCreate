import { describe, it, expect } from "vitest";

import { runInSandbox, runFunctionSandboxed } from "@/lib/sandbox/function_sandbox";

describe("function_sandbox (LR10 hardening)", () => {
  it("runs a pure function and returns its output", async () => {
    const res = await runInSandbox("return input.a + input.b;", { a: 2, b: 3 });
    expect(res.ok).toBe(true);
    expect(res.output).toBe(5);
    expect(res.timedOut).toBe(false);
  });

  it("denies require() of a non-allow-listed module", async () => {
    const res = await runInSandbox("const fs = require('fs'); return typeof fs;", {});
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/blocked by the sandbox policy/);
  });

  it("denies require() of node:child_process by default", async () => {
    const res = await runInSandbox(
      "return require('node:child_process').execSync('echo hi').toString();",
      {},
    );
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/blocked by the sandbox policy/);
  });

  it("permits an explicitly allow-listed module", async () => {
    const res = await runInSandbox(
      "const c = require('node:crypto'); return typeof c.randomUUID;",
      {},
      { allowedModules: ["node:crypto"] },
    );
    expect(res.ok).toBe(true);
    expect(res.output).toBe("function");
  });

  it("scrubs the ambient process global", async () => {
    const res = await runInSandbox("return typeof process;", {});
    expect(res.ok).toBe(true);
    expect(res.output).toBe("undefined");
  });

  it("closes the Function('return process') escape hatch", async () => {
    const res = await runInSandbox("return typeof (Function('return process')());", {});
    expect(res.ok).toBe(true);
    expect(res.output).toBe("undefined");
  });

  it("terminates a runaway loop at the timeout", async () => {
    const res = await runInSandbox("while (true) {}", {}, { timeoutMs: 300 });
    expect(res.ok).toBe(false);
    expect(res.timedOut).toBe(true);
  });

  it("runFunctionSandboxed throws on a blocked require", async () => {
    await expect(runFunctionSandboxed("return require('fs');", {})).rejects.toThrow(
      /blocked by the sandbox policy/,
    );
  });
});
