# LR10 — Phase 2: Sandboxed Code Skill

**Status:** ✅ Done (as-built)
**Track:** A (Agentic Runtime)
**Escalation:** introduces **sandboxed code execution** (beyond Phase 1's
declarative-only rule). Accepted with mandatory worker-sandbox hardening.
**Depends on:** LR9 (skill kinds), `function_sandbox` (worker isolate).

---

## As-built (implemented)

A third skill kind — `code-agent` — carries JavaScript source that runs in a
**hardened worker-thread sandbox**, never `eval`/`require`d in the main process.
The same LR2 license + LR3 PoU gate still runs before any execution.

- **Hardened sandbox** — [src/lib/sandbox/function_sandbox.ts](../../src/lib/sandbox/function_sandbox.ts):
  - New `SandboxRunOptions.allowedModules` — a **deny-all-by-default** `require`
    allow-list. A guarded `require` is captured before scrubbing and only
    resolves listed module names; everything else throws
    `require('…') is blocked by the sandbox policy`.
  - Ambient escape hatches are shadowed as AsyncFunction parameters
    (`require`, `process`, `module`, `__dirname`, `__filename`, `global`) **and**
    the real `globalThis.process` / `globalThis.require` are best-effort
    scrubbed — closing the `Function("return process")()` path.
  - New `maxMemoryMb` (default 128) maps to the worker's
    `resourceLimits.maxOldGenerationSizeMb`; the hard `timeoutMs` tear-down is
    unchanged.
  - Residual risk (documented): dynamic `import()` is syntactic and can't be
    stripped from an in-process worker — for *fully* untrusted marketplace code,
    use the container-isolated `JcnJobExecutor` Docker path.
- **`code-agent` bundle** — [src/lib/onchain/skill_runtime.ts](../../src/lib/onchain/skill_runtime.ts):
  `CodeAgentBundle { kind: "code-agent", code, allowedModules?, timeoutMs?, maxMemoryMb? }`.
  Interfaces were refactored into `SkillBundleCommon` + `ModelSkillFields` so a
  code-agent needs no `modelId`/`systemPrompt`. `parseSkillBundle` validates the
  code string, the module list, and clamps `timeoutMs` / `maxMemoryMb` to
  `MAX_CODE_TIMEOUT_MS` (30 s) / `MAX_CODE_MEMORY_MB` (256 MiB).
- **Injectable executor** — new `CodeAgentFn` dep (default lazily imports
  `runInSandbox`). `executeSkill` branches to it for `code-agent`, returning the
  output (JSON-stringified if non-string) with `kind: "code-agent"`.
- **`runtime_invoke` surface** —
  [src/mcp_server/tools/web4_marketplace_tools.ts](../../src/mcp_server/tools/web4_marketplace_tools.ts):
  reports `executionMode: "local-ipld code-agent (LR10)"`.

**Tests:** [src/__tests__/function_sandbox.test.ts](../../src/__tests__/function_sandbox.test.ts)
(8 — pure run, blocked `fs`/`child_process`, allow-listed `node:crypto`,
scrubbed `process`, closed `Function` escape, timeout, throwing wrapper) and
[src/__tests__/skill_runtime.test.ts](../../src/__tests__/skill_runtime.test.ts)
(28 total — valid/invalid code-agent parse, cap clamping, injected-executor
routing, non-string output stringify). All pass; oxlint clean.

**Deferred:** `bundleCid`-referenced code bundles and the `JcnJobExecutor` Docker
path for heavy/long-running compute are a later "heavy compute" follow-up; LR10
ships inline `code` in the bundle.

---

## Goal

Let a Licensed Runtime Asset ship real executable logic — not just a prompt —
while guaranteeing process isolation, a require allow-list, a heap cap, and a
hard timeout, and keeping the license + PoU gate authoritative.

---

## Work

1. Harden `function_sandbox`: deny-all `require` allow-list, global scrub,
   `maxMemoryMb` heap cap.
2. Add `code-agent` skill kind + validation; refactor bundle interfaces so code
   skills don't carry model fields.
3. Add an injectable `CodeAgentFn`; default to the hardened sandbox.
4. Surface `executionMode: "local-ipld code-agent (LR10)"`.

---

## Manual verification

1. Pin a `code-agent` bundle; `runtime_invoke` with `input` runs it in the
   sandbox and returns its output.
2. Code that `require('fs')` (or `child_process`, `net`) is **rejected** unless
   the bundle allow-lists it.
3. A runaway loop is killed at `timeoutMs`; a memory bomb is capped by
   `maxMemoryMb`.
4. License `runtimeExecution: false` (or missing PoU) is refused before any code
   runs.

---

## Decisions

- `require` is **deny-all by default**; the bundle opts specific modules in.
- Hard caps (`MAX_CODE_TIMEOUT_MS`, `MAX_CODE_MEMORY_MB`) override bundle values.
- Fully untrusted code belongs in the container path; the in-process worker is
  hardened defense-in-depth, not a perfect jail (dynamic `import()` residual).

## Notes

- Chain-agnostic; ships on Sepolia and carries to mainnet unchanged.
