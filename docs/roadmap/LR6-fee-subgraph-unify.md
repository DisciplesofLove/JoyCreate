# LR6 — x402 Store-Reg Fee + Goldsky Subgraph + ENS↔Slug Unification

**Status:** ✅ Done (as-built)
**Closes:** G4 (no store-registration fee), G6 (no 8004/glue subgraph; identities not unified)
**Depends on:** LR1–LR5 (the full flow exists and emits the events to index).

---

## As-built (implemented)

All three parts landed; 16 new unit tests pass, oxlint clean, no TS errors.

### 1. Store-registration fee (G4)

- [src/config/x402.ts](../../src/config/x402.ts) — `STORE_REGISTRATION_FEE_ATOMIC`
  (1 USDC), `REGISTRATION_FEE_RECIPIENTS` (platform Treasury per chain),
  `getRegistrationFeeRecipient`, `isRegistrationFeeReady`.
- [src/lib/x402/registration_fee.ts](../../src/lib/x402/registration_fee.ts) —
  `settleRegistrationFee(wallet, {chain, slug})` composes
  `createPaymentRequirements` → `createPayment` → `settlePayment`, routed through
  the RevenueSplitter (contracts hold no funds). Skips (non-fatal) on a chain
  with no fee configured; **throws** on settlement failure so a paid chain never
  registers for free.
- Wired at both registration entry points:
  - [publish_and_monetize.ts](../../src/lib/joymarketplace/publish_and_monetize.ts)
    auto-register branch via `chargeRegistrationFee?: boolean` (settled before
    `registerStore`; `registrationFee` returned in the outcome).
  - [glue_handlers.ts](../../src/ipc/handlers/glue_handlers.ts) `glue:register-store`
    via `payFee?: boolean`, surfaced as `payFee` on the LR5
    [`store_register`](../../src/mcp_server/tools/web4_marketplace_tools.ts) MCP tool.
- Tests: [registration_fee.test.ts](../../src/__tests__/registration_fee.test.ts) (4).

### 2. Goldsky subgraph (G6)

- Subgraph source authored under [subgraph/](../../subgraph/): `schema.graphql`
  (Agent / Store / Drop / Mint / Feedback / Mandate), `subgraph.yaml` (5 data
  sources — IdentityRegistry, ReputationRegistry, StoreRegistry,
  EditionController, AgentMandate on `arbitrum-sepolia`), event-only `abis/*.json`,
  AssemblyScript `src/mapping.ts`, `package.json`, `tsconfig.json`, `README.md`.
- ⚠️ **Manual redeploy required** — the Goldsky deploy cannot be automated. See
  [subgraph/README.md](../../subgraph/README.md) for steps; set each data
  source's `startBlock` before deploying.
- Runtime fast-path with RPC fallback:
  [src/config/subgraphs.ts](../../src/config/subgraphs.ts) adds the unified
  `marketplace` endpoint (empty until deploy; env-overridable);
  [subgraph_discovery.ts](../../src/lib/onchain/subgraph_discovery.ts)
  (`getStoreCached` / `getDropCached` / `hasMarketplaceSubgraph`) reads the
  subgraph when configured and falls back to RPC on any miss/error;
  [interface_broker.ts](../../src/lib/onchain/interface_broker.ts) discovery now
  routes through these cached reads.
- Tests: [subgraph_discovery.test.ts](../../src/__tests__/subgraph_discovery.test.ts) (7).

### 3. ENS ↔ slug unification (G6)

- [src/lib/onchain/store_identity.ts](../../src/lib/onchain/store_identity.ts) —
  canonical direction **slug → name**: `canonicalStoreName(slug)` and
  `reconcileStoreIdentity(chain, storeId)` (resolves the derived ENS name and
  compares to the store's ERC-8004 agent address, falling back to the owner;
  read-only, reports `unified`/`reason`).
- Tests: [store_identity.test.ts](../../src/__tests__/store_identity.test.ts) (5).

**Deferred:** publishing/writing ENS records to *close* a reconciliation gap
(this milestone only verifies); reconciling the separate `.joy` BaseRegistrar
system with the hierarchical `marketplace.eth` tree. LR7 redeploys the subgraph
against Arbitrum One and fills mainnet addresses + `arbitrumOne` endpoints.

---

## Goal

Three discovery/monetization closers:

1. **x402 store-registration fee** — charge a fee on store registration at the
   HTTP/MCP layer, routed through RevenueSplitter (contracts hold no funds).
2. **Goldsky subgraph for 8004/glue events** — index the events the broker
   currently reads via RPC, so discovery is fast.
3. **ENS `.joy` ↔ StoreRegistry slug unification** — one canonical store identity
   across both naming systems.

---

## Work

### 1. Store-registration fee (G4)

- Add an x402 challenge/settlement at the store-registration entry point (likely
  in [publish_and_monetize.ts](../../src/lib/joymarketplace/publish_and_monetize.ts)
  auto-register branch and/or the LR5 `store_register` tool), reusing
  [x402/server.ts](../../src/lib/x402/server.ts) (`createPaymentRequirements` →
  `verifyPayment` → `settlePayment`).
- Only **edition purchases** charge x402 today; this adds the registration fee.
  Split per RevenueSplitter (platform/protocol portions for a registration).

### 2. Goldsky subgraph (G6)

- Author a subgraph schema + handlers for: `AgentRegistered`, `StoreRegistered`,
  `DropCreated`, `Minted`, `FeedbackSubmitted` (and mandate events if useful).
- Point [interface_broker.ts](../../src/lib/onchain/interface_broker.ts) discovery
  and [src/routes/joy/marketplace.ts](../../src/routes/joy/marketplace.ts) at the
  subgraph instead of RPC reads (keep RPC as fallback).
- **Manual redeploy required** — prepare schema/handlers, then flag that the
  Goldsky redeploy is a manual step (cannot be automated).

### 3. ENS ↔ slug unification (G6)

- Reconcile the ENS `.joy` name (BaseRegistrar / JoyResolver, see
  [src/config/joymarketplace.ts](../../src/config/joymarketplace.ts)) with the
  StoreRegistry `slug` + `agentId`, so `storeName(slug)` and the on-chain store
  resolve to the same identity. Decide the canonical direction (slug → name).

---

## Manual verification (Arbitrum Sepolia)

1. Register a store via the fee path → a RevenueSplitter `RevenueSplit` event with
   platform/protocol amounts; the StoreRegistry contract holds no fee funds.
2. Within ~60s of each tx, the subgraph returns the new
   `Store`/`Drop`/`Agent`/`Feedback` entities.
3. Marketplace browse loads from the subgraph (not RPC).
4. A store's `.joy` ENS name resolves to the same slug + `agentId` as its
   StoreRegistry record.

---

## Decisions

- Fees are routed at the **HTTP/MCP layer** via RevenueSplitter; contracts stay
  fund-free (LR0 principle).
- Subgraph redeploy is **manual** and explicitly flagged.

## Notes for next milestone

- LR7 redeploys these subgraphs against Arbitrum One and fills mainnet addresses.
