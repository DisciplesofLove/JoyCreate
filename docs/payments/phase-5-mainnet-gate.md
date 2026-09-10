# Phase 5 — Mainnet Gate (Arbitrum One)

> **BLOCKED ON PHASE 4.** Do not deploy to Arbitrum One before the audit
> completes with all High/Critical findings resolved.

## Goal

Bring the live 80/10/10 rail to Arbitrum One and flip the UI from Preview to
Live for mainnet.

## Tasks

1. Deploy the audited RevenueSplitter (frozen, tagged source) to Arbitrum One
   using the existing Stylus deploy pattern (`cargo stylus deploy`, then the
   `initialize`/`set_wallets` script pattern in the crate directory).
2. Initialize with **mainnet** wallets: Platform+DAO treasury Safe and the
   compute wallet — never the deployer EOA.
3. Deploy/verify the glue contracts (StoreRegistry, EditionController,
   AgentMandate) on Arbitrum One if not already present.
4. Update `REVENUE_SPLITTER_CONTRACTS.arbitrumOne` (and glue addresses) in
   `src/config/x402.ts` / `src/config/glue.ts`.
5. Update [split-config.json](split-config.json) (`status: "live"`) and
   [deployments.json](deployments.json) with addresses + tx hashes.
6. UI flips automatically: `isX402Ready("arbitrumOne")` becomes true, so the
   Preview caption is replaced by the Live badge with no code change.

## Verification checklist (manual, mainnet)

- [ ] `getConfig()` returns the Safe + compute wallet, owner is the expected
      admin key (ideally the Safe).
- [ ] Smoke purchase with a tiny amount (e.g. $0.05): three transfers to the
      three mainnet recipients, amounts match `computeSplit()`.
- [ ] App on `arbitrumOne` shows the Live badge and completes a purchase
      end-to-end (settle → mint → receipt).

## Exit criteria

A real mainnet purchase settles 80/10/10 to the production wallets.
