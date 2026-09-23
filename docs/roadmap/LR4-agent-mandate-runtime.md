# LR4 — AgentMandate Runtime Autonomy

**Status:** ✅ Done (as-built) — blueprint allowance annotation deferred
**Closes:** part of G5 (agent authorization surface)
**Depends on:** LR3 (purchase + feedback loop exists to delegate).

---

## As-built (implemented)

- **Mandate lifecycle was already wired** through IPC (`glue:create-mandate`,
  `glue:record-spend`, `glue:revoke-mandate`, `glue:is-mandate-valid`,
  `glue:can-spend`, `glue:get-mandate`, `glue:mandate-count`) with matching
  `ipc_client` methods, backed by
  [glue_client.ts](../../src/lib/onchain/glue_client.ts). `setStoreAgent` (work
  item #3) likewise exists as `glue:set-store-agent`.
- **New authorized purchase path** — `purchaseEditionWithMandate(wallet, { chain,
  dropId, mandateId, feedbackScore? })` in
  [purchase_orchestrator.ts](../../src/lib/x402/purchase_orchestrator.ts):
  pre-flights the mandate on-chain (`isMandateValid` + `canSpend`) **before** any
  USDC moves, runs `purchaseEdition` (settle → grantProof → mint → LR3 feedback),
  then charges the cap with `recordSpend`. Returns `MandatePurchaseResult`
  (`{ ...PurchaseResult, mandateId, recordSpendTxHash }`).
- **New IPC channel** `x402:purchase-edition-with-mandate` (4-edit checklist
  complete: handler in [x402_handlers.ts](../../src/ipc/handlers/x402_handlers.ts),
  registered via the existing `registerX402Handlers`, allowlisted in
  [preload.ts](../../src/preload.ts), client method
  `x402PurchaseEditionWithMandate` + types `X402MandatePurchaseResult` /
  `X402PurchaseFeedback` in [ipc_client.ts](../../src/ipc/ipc_client.ts)).
- Tests: [src/__tests__/purchase_with_mandate.test.ts](../../src/__tests__/purchase_with_mandate.test.ts) (4).

**Deferred (work item #4):** annotating the blueprint identity/store node with the
bound operating agent + remaining mandate allowance (read-only discovery aid).

---

## Goal

Let a **runtime agent** license/purchase assets on a principal's behalf, bounded
by an on-chain **AgentMandate** spend limit. This is the authorization model the
brief mis-attributed to the Validation Registry — JoyCreate uses the purpose-built
`AgentMandate` contract instead.

---

## Deployed interface (verified)

- **AgentMandate** `0xe326ec66…`: `createMandate(...)` (delegated spend limits),
  `recordSpend(...)`. Wrapped in
  [glue_client.ts](../../src/lib/onchain/glue_client.ts) as `createMandate` /
  `recordSpend` (+ `MandateRecord`).
- **StoreRegistry** `setAgent(storeId, agentId)` — binds an operating agent to a
  store ([glue_client.ts](../../src/lib/onchain/glue_client.ts) `setStoreAgent`).

---

## Work

1. **Mandate lifecycle** — surface create/read/revoke of a mandate (principal →
   agent, with a USDC spend cap and optional expiry) through an IPC channel +
   client method (4-edit checklist).
2. **Authorized purchase path** — extend the purchase orchestrator so a call can
   be made *as an agent under a mandate*: verify remaining allowance, execute the
   x402 purchase, then `recordSpend` for the spent amount. Reject (revert) when
   the purchase would exceed the cap.
3. **Store-agent binding** — when a store wants an operating agent, call
   `setStoreAgent(storeId, agentId)` and reflect it on the blueprint identity.
4. **Blueprint** — optionally annotate the identity/store node with the bound
   operating agent + remaining mandate allowance (read-only discovery aid).

---

## Manual verification (Arbitrum Sepolia)

1. Principal creates a mandate for an agent with a small USDC cap.
2. The agent completes a purchase **within** budget → succeeds; `recordSpend`
   reflects the amount; remaining allowance decreases.
3. The agent attempts a purchase **over** the remaining cap → **reverts**; no
   spend recorded.
4. `setStoreAgent` binds the agent; the store blueprint shows the operating agent.

---

## Decisions

- Authorization is **AgentMandate + `setAgent`** (LR0 decision #2), never the
  brief's `authorize`/`isAuthorized`.
- Spend accounting is on-chain via `recordSpend`; the app never trusts a
  client-side allowance.

## Notes for next milestone

- LR5 exposes mandate creation + authorized purchase as MCP tools
  (`agent_authorize`, and the purchase tool gains a mandate context).
