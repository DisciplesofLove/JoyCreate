# LR13 — Identity ↔ A2A Principal Bridge

**Status:** ✅ Done (as-built)
**Track:** B (A2A interop)
**Builds on:** LR11 (skill on the agent card), the A2A economy
(`src/lib/a2a_economy.ts`), ERC-8004 identity (`erc8004_client.getAgent`).
**Enables:** LR14 (A2A runtime executor + cross-agent invoke).

---

## As-built (implemented)

Mirrors an ERC-8004 on-chain agent into the local A2A economy so other agents
can discover and pay for its Licensed Runtime Asset.

- **Bridge library** — [src/lib/onchain/lra_a2a_bridge.ts](../../src/lib/onchain/lra_a2a_bridge.ts):
  - `bridgeIdentityToA2a(input, deps?)`:
    1. ensures the agent has an A2A **principal** (DID + budget) via
       `getOrCreatePrincipal`, seeding the payout wallet with the on-chain
       controller address;
    2. **reconciles** the principal's payout wallet ↔ the on-chain controller
       (`updatePrincipalPayoutWallet`) when they drift;
    3. publishes (or **reuses**, idempotently) a service listing under the
       `lra.runtime` capability, carrying the on-chain binding
       (`erc8004AgentId` + `chain` + `agentAddress` + `skillCid`) under the
       namespaced `x-lra-binding` key on `inputSchemaJson` — no schema
       migration needed.
  - `readListingBinding(listing)` recovers that binding (used by LR14's
    executor).
  - `LRA_RUNTIME_CAPABILITY` (`"lra.runtime"`) + `LRA_BINDING_KEY`
    (`"x-lra-binding"`) are exported as the shared contract.
  - All A2A persistence is injected (`BridgeDeps`) so the orchestration is
    unit-tested without the SQLite + SSI stack.
- **Reconcile helper** — [src/lib/a2a_economy.ts](../../src/lib/a2a_economy.ts):
  new `updatePrincipalPayoutWallet(principalId, payoutWallet)` (mirrors
  `setPrincipalBudget`; no-op when unchanged).
- **IPC channel** — [src/ipc/handlers/runtime_handlers.ts](../../src/ipc/handlers/runtime_handlers.ts):
  `runtime:bridge-a2a` resolves the on-chain controller via `getAgent` and the
  current `skillCid` via `resolveSkill` (best-effort), then calls the bridge.
  Wired through preload allowlist + `runtimeBridgeA2a` in
  [src/ipc/ipc_client.ts](../../src/ipc/ipc_client.ts) (with
  `RuntimeBridgeA2aResult`).

**Tests:** [src/__tests__/lra_a2a_bridge.test.ts](../../src/__tests__/lra_a2a_bridge.test.ts)
(7 — create+bind, payout reconcile, idempotent reuse, distinct-agent
non-reuse, validation, and `readListingBinding`). oxlint clean.

---

## Goal

Make an on-chain Licensed Runtime Asset a first-class, discoverable, payable
participant in the A2A economy — without duplicating identity or forking the
schema.

---

## Work

1. `lra_a2a_bridge.ts`: `bridgeIdentityToA2a` + `readListingBinding` + the
   capability/binding-key constants (injectable A2A deps).
2. `updatePrincipalPayoutWallet` in `a2a_economy.ts`.
3. `runtime:bridge-a2a` IPC channel (handler + ipc_host + preload + ipc_client +
   `RuntimeBridgeA2aResult`).

---

## Manual verification

1. `runtime:bridge-a2a` for an ERC-8004 agent returns a `principalId`, `did`,
   and a `lra.runtime` `listingId` carrying the on-chain binding.
2. Calling it twice for the same agent reuses the listing
   (`createdListing: false`).
3. The principal's payout wallet equals the on-chain controller address.

---

## Decisions

- The on-chain binding lives on the listing's `inputSchemaJson` under
  `x-lra-binding` (namespaced) — reuses existing tables, no migration.
- Bridge is **idempotent** per `(erc8004AgentId, chain)`.
- A2A persistence is injected so the orchestration is unit-tested without a DB.

## Notes

- The principal is anchored to a local `agents.id` (`localAgentId`); the on-chain
  agentId is carried in the binding, not the principal row.
- Chain-agnostic; ships on Sepolia and carries to mainnet unchanged.
