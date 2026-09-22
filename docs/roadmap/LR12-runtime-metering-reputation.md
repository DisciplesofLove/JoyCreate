# LR12 — Runtime Metering + Reputation Feedback

**Status:** ✅ Done (as-built)
**Track:** A (Agentic Runtime)
**Builds on:** LR8–LR11 (the local skill runtime + authoring), LR3 (ERC-8004
ReputationRegistry feedback).

---

## As-built (implemented)

Per-invocation accounting that wraps the local skill runtime, plus an optional
auto-feedback loop and a charge hook — all injectable so the orchestration is
unit-tested without a wallet, a contract, or real time.

- **Metering library** — [src/lib/onchain/runtime_metering.ts](../../src/lib/onchain/runtime_metering.ts):
  - `invokeAndMeter(input, deps?)` runs `invokeSkillRuntime`, measures
    wall-clock duration, captures token usage, and returns a structured
    `RuntimeReceipt` (`agentId`, `skillCid`, `kind`, `modelId`, `output`,
    `finishReason`, `steps`, `usage`, `startedAt`, `finishedAt`, `durationMs`).
  - **Optional reputation feedback** — when `input.feedback` is set, submits
    ERC-8004 `submitFeedback` (LR3) after the run (default score
    `DEFAULT_SUCCESS_SCORE = 100`). Failure is logged and does NOT discard the
    already-produced output (`feedbackTxHash` left unset).
  - **Optional micro-charge** — `deps.charge` runs a per-invocation x402 /
    RevenueSplitter charge; the resulting `chargeTxHash` lands on the receipt.
    Also best-effort.
  - Injectable `MeterDeps` (`invoke`, `submitFeedback`, `charge`, `now`).
- **IPC channel** — [src/ipc/handlers/runtime_handlers.ts](../../src/ipc/handlers/runtime_handlers.ts):
  `runtime:invoke` loads the active jcnKeyManager chain wallet (only when
  feedback is requested, so the wallet never leaves main) and calls
  `invokeAndMeter`. Throws on error. Wired through the full IPC contract:
  registered in [src/ipc/ipc_host.ts](../../src/ipc/ipc_host.ts), allowlisted in
  [src/preload.ts](../../src/preload.ts), exposed as `runtimeInvoke` in
  [src/ipc/ipc_client.ts](../../src/ipc/ipc_client.ts) (with the
  `RuntimeInvokeReceipt` type).
- **MCP tool** — [src/mcp_server/tools/web4_marketplace_tools.ts](../../src/mcp_server/tools/web4_marketplace_tools.ts):
  `runtime_invoke` now routes through `invokeAndMeter` and surfaces a `metering`
  block (`durationMs`, `startedAt`, `finishedAt`) in its output.

**Tests:** [src/__tests__/runtime_metering.test.ts](../../src/__tests__/runtime_metering.test.ts)
(5 — metering, feedback submit, feedback-failure resilience, micro-charge,
no-feedback). Existing `web4_marketplace_tools` (11) and `skill_runtime` (28)
suites still pass. oxlint clean.

---

## Goal

Make each runtime invocation accountable: capture how long it ran and how many
tokens it used, optionally rate the provider on-chain, and optionally charge for
the call — without ever dropping the produced output if a side-effect fails.

---

## Work

1. `runtime_metering.ts`: `invokeAndMeter` + `RuntimeReceipt` (injectable deps).
2. `runtime:invoke` IPC channel (handler + ipc_host + preload + ipc_client +
   `RuntimeInvokeReceipt`).
3. `runtime_invoke` MCP tool surfaces metering.

---

## Manual verification

1. `runtime_invoke` with an `input` returns a `metering` block with a non-zero
   `durationMs` plus `startedAt` / `finishedAt`.
2. `runtime:invoke` with `submitFeedback: true` + `clientId` produces a
   `feedbackTxHash` and the provider's `getReputationScore` reflects the rating.
3. A failing feedback submission still returns the runtime output.

---

## Decisions

- Feedback + charge are **best-effort side effects**: never discard a successful
  runtime output because a downstream tx failed.
- The signing wallet is loaded **only in main**, and only when feedback is
  actually requested.
- No new persistence table — the receipt is returned; the existing rewards /
  receipt ledgers remain authoritative.

## Notes

- The x402 / RevenueSplitter `charge` is a hook (`deps.charge`); the concrete
  per-invocation settlement rail is bridged in LR14's A2A flow.
- Chain-agnostic; ships on Sepolia and carries to mainnet unchanged.
