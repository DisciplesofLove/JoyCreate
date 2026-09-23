# LR3 — Proof-of-Use + Validation + Reputation (License Enforcement)

**Status:** ✅ Core done (as-built) — validation path + trust-badge UI deferred
**Closes:** G3 (reputation read but never submitted post-purchase)
**Depends on:** LR2 (structured license, esp. the `runtimeExecution` flag).

---

## As-built (implemented)

- **PoU was already wired** in
  [purchase_orchestrator.ts](../../src/lib/x402/purchase_orchestrator.ts):
  `grantProof(dropId, buyer)` runs before `mint` whenever `drop.requiresProof`.
- [src/lib/onchain/reputation.ts](../../src/lib/onchain/reputation.ts) —
  `submitPurchaseFeedback(wallet, { chain, serverId, buyer, score?, feedbackUri? })`
  resolves the buyer's `clientId` (`resolveByAddress`), enforces the two-sided
  policy (auto-`acceptFeedback` only when this wallet owns the serving agent,
  else benign skip with reason), then `submitFeedback`. Plus `buildFeedbackReceipt`
  (pinnable purchase receipt, schema `joy-feedback/1.0`) and `DEFAULT_PURCHASE_SCORE = 100`.
- [purchase_orchestrator.ts](../../src/lib/x402/purchase_orchestrator.ts) — after a
  settled mint, calls `submitPurchaseFeedback` **best-effort** (a reputation hiccup
  never fails an already-settled purchase) and returns the outcome on
  `PurchaseResult.feedback`. No new IPC channel needed (runs inside the existing
  `x402:purchase-edition` path).
- Tests: [src/__tests__/reputation.test.ts](../../src/__tests__/reputation.test.ts) (8).

**Deferred (not blocking the trust loop):** the optional ValidationRegistry
attestation path (the `validationRequest`/`validationResponse` client fns already
exist in [erc8004_client.ts](../../src/lib/onchain/erc8004_client.ts)) and the
trust-badge UI (the blueprint already carries a `reputation` node from LR1).

---

## Goal

Close the trust loop. After an x402 purchase:

1. Record **Proof-of-Use** (`grantProof`) so the buyer's right — especially the
   LR2 `runtimeExecution` flag — becomes enforceable on-chain.
2. Submit **reputation feedback** to the ReputationRegistry so `averageScore`
   reflects real transactions, and surface on-chain trust badges in the UI.
3. Optionally request a **validation attestation** on the content merkle root via
   the ValidationRegistry for data-market / integrity-sensitive assets.

---

## Deployed interfaces (verified — use these, not the brief's)

- **ReputationRegistry** `0x82718a93…`: `acceptFeedback`,
  `submitFeedback(clientId, serverId, score, bytes)`, `getScore` →
  `(count, sum)`, `averageScore`. (Wrapped in
  [erc8004_client.ts](../../src/lib/onchain/erc8004_client.ts) — confirm exact
  client method names before wiring.)
- **ValidationRegistry** `0x9edcbf7f…`: `validationRequest`,
  `validationResponse(dataHash, score)`. (**Not** `authorize`/`isAuthorized` —
  the brief is wrong here.)
- **EditionController** `0x93b334…`: `grantProof` (PoU), `mint` (PoU-gated when the
  drop `requiresProof`).

---

## Work

1. **Post-purchase hook** — in
   [purchase_orchestrator.ts](../../src/lib/x402/purchase_orchestrator.ts) /
   [x402_handlers.ts](../../src/ipc/handlers/x402_handlers.ts), after a settled
   purchase: call `grantProof(dropId, buyer)` when the drop/license requires it,
   then `submitFeedback(...)` against the store/serving agent's identity.
2. **ReputationRegistry feedback flow** — the registry uses `submitFeedback` +
   `acceptFeedback` (two-sided). Decide the auto-accept policy (likely the server
   agent auto-accepts purchase feedback) and wire both sides. Score scale and the
   `bytes` metadata payload (e.g. an `ipfs://` receipt) need to be fixed here.
3. **Validation attestation (optional path)** — for data-market assets, call
   `validationRequest` with the content merkle root, then surface the
   `validationResponse(dataHash, score)` on the blueprint.
4. **Trust badges (UI)** — read `averageScore` / `count` and render a badge in
   [src/routes/joy/marketplace.ts](../../src/routes/joy/marketplace.ts) and the
   marketplace asset views. The blueprint already carries a `reputation` node
   (LR1) — reuse it.
5. **IPC** — if a new channel is needed (e.g. `reputation:submit`), follow the
   4-edit checklist (handler + ipc_host + preload + ipc_client; throw on error).
6. **Gasless settlement (per LR0 decision #7)** — adopt the cloud's gasless
   EIP-3009 relayer model: the buyer signs `transferWithAuthorization` (USDC, zero
   ETH) and a relayer pays Arbitrum gas + settles via [x402/server.ts](../../src/lib/x402/server.ts).
   Cloud-minted editions may settle through the cloud relayer directly; JoyCreate's
   own drops settle through JoyCreate's relayer against the local EditionController.

---

## Manual verification (Arbitrum Sepolia)

1. Complete an x402 edition purchase.
2. Confirm a `grantProof` tx for the buyer when the drop `requiresProof`; a
   subsequent gated `mint` succeeds.
3. Confirm a `FeedbackSubmitted` (and accepted) event; `averageScore` for the
   store identity increments on 8004scan.
4. For a data-market asset, confirm a `validationRequest` + `validationResponse`
   on the content hash.
5. The marketplace renders the on-chain trust badge from the live score.

---

## Decisions

- Reputation is submitted **only on settled purchases** (no self-feedback spam).
- On-chain enforcement of the **runtime-execution** right is implemented here via
  PoU `grantProof` (the LR2 flag → LR3 gate).

## Notes for next milestone

- LR4 lets a **mandated agent** trigger this same purchase+feedback loop
  autonomously within a spend cap.
