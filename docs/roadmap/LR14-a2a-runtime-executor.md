# LR14 — A2A Runtime Executor + Cross-Agent Invoke

**Status:** ✅ Done (as-built)
**Track:** B (A2A interop)
**Builds on:** LR13 (the `lra.runtime` listing + binding), LR12 (metered
invoke), LR8–LR10 (the runtime), the A2A economy executor seam.
**Completes:** Phase 2 — an external agent can now discover, pay for, and
invoke another agent's Licensed Runtime Asset end to end.

---

## As-built (implemented)

The pluggable A2A executor for the `lra.runtime` capability. When an A2A
contract for that capability is invoked, this executor runs the bound agent's
LRA behind the same license + Proof-of-Use gate as a direct `runtime_invoke`.

- **Executor library** — [src/lib/onchain/lra_a2a_executor.ts](../../src/lib/onchain/lra_a2a_executor.ts):
  - `createLraRuntimeExecutor(deps?)` returns an `InvocationExecutor` that:
    1. recovers the on-chain binding from the listing via `readListingBinding`
       (LR13) — throws if the listing was never bridged;
    2. extracts the string `input` from the invocation payload (and the
       consumer-supplied `license` / `dropId` / `buyer`);
    3. calls `invokeAndMeter` (LR12) — **never bypassing** `assertRuntimeGate`;
    4. returns `{ output, inputTokens, outputTokens, provider: "lra.runtime",
       model }` so the A2A contract can settle.
  - The runtime invoker is injected so the executor is unit-tested without the
    model / IPFS / chain stack.
- **Registration** — [src/ipc/handlers/runtime_handlers.ts](../../src/ipc/handlers/runtime_handlers.ts):
  `registerRuntimeHandlers()` now calls
  `registerA2aExecutor(LRA_RUNTIME_CAPABILITY, createLraRuntimeExecutor())`,
  wiring the executor into the A2A invoke path (`a2a:contract:invoke` →
  `invokeContract` → this executor). The module-level executor registry means
  registration order vs. `registerA2aHandlers` is irrelevant.

**Tests:** [src/__tests__/lra_a2a_executor.test.ts](../../src/__tests__/lra_a2a_executor.test.ts)
(4 — binding recovery + gated invoke, missing-binding rejection, missing-input
rejection, null-license passthrough). Full Phase 2 set (84 tests across 8
suites) green. oxlint clean.

---

## Goal

Close the loop: let one agent pay another (via the A2A escrow state machine) to
run its Licensed Runtime Asset, with payment settling to the provider only after
delivery + verification.

---

## Full cross-agent flow

```
discover (A2A listing, capability=lra.runtime)
  → requestQuote → acceptQuote
  → escrowContract (rewardsLedger holds funds)
  → invokeContract  ─► createLraRuntimeExecutor()
                         ├─ readListingBinding (chain + erc8004AgentId + skillCid)
                         └─ invokeAndMeter (license + PoU gate, metered)
  → DELIVERED → verifyInvocation("accept")
  → SETTLED (funds released to the provider principal's payout wallet)
```

---

## Work

1. `lra_a2a_executor.ts`: `createLraRuntimeExecutor` (injectable invoker).
2. Register it under `lra.runtime` in `registerRuntimeHandlers`.

---

## Manual verification

1. Bridge an agent (LR13), create a quote + contract against the `lra.runtime`
   listing, escrow, then `a2a:contract:invoke` with
   `{ input, license: { runtimeExecution: true } }`.
2. The contract reaches `DELIVERED` with the runtime output in the invocation
   record; verify → settle releases escrow to the provider.
3. Invoking with a license that denies `runtimeExecution` fails the invocation
   (the runtime gate throws), leaving escrow intact for refund.

---

## Decisions

- The executor **reuses** the metered runtime path (LR12) — one gate, one
  metering story for direct and cross-agent invocation.
- Authorization (license/PoU) travels in the invocation **input**; the executor
  never weakens the gate just because payment escrowed.
- The executor is registered from the runtime handler (not the A2A handler) to
  keep all LRA-runtime concerns co-located.

## Notes

- Bridging A2A escrow → x402 / RevenueSplitter settlement is available through
  LR12's `charge` hook; the A2A state machine already settles via
  `rewardsLedger`, so the on-chain bridge is an optional follow-up.
- Chain-agnostic; ships on Sepolia and carries to mainnet unchanged.
