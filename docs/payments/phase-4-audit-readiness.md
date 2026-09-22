# Phase 4 — Audit Readiness (mainnet gate)

## Goal

Package the RevenueSplitter for an independent security audit. **The audit is
the gate for Phase 5 (Arbitrum One deployment).** Until it completes, mainnet
stays in Preview mode.

## Scope

Single contract: `contracts/revenue_splitter_stylus/` (Arbitrum Stylus, Rust).
Interface surface (see `REVENUE_SPLITTER_ABI` in `src/config/x402.ts`):
`initialize`, `owner`, `setWallets`, `distribute`, `distributeAll`,
`creatorEarnings`, `totalDistributed`, `getConfig`, events `RevenueSplit`,
`WalletsUpdated`.

Full invariants, threat model and known issues: [audit/scope.md](audit/scope.md).

## Process

1. Freeze the contract source; tag the commit (`revenue-splitter-audit-v1`).
2. Commission an auditor with Arbitrum Stylus (Rust/WASM) experience.
3. Track findings in `docs/payments/audit/findings.md`; every High/Critical
   must be fixed + re-reviewed before Phase 5.
4. Contingency: if the audit surfaces fundamental design flaws, migrate to
   the audited **0xSplits** protocol on Arbitrum instead of patching —
   decision point documented here, not taken unilaterally.

## Pre-audit verification checklist (manual, Sepolia)

- [ ] For a set of purchases (min price, odd remainder, large price):
      `creatorAmount + platformAmount + protocolAmount == amount` on every
      `RevenueSplit` event.
- [ ] `totalDistributed(USDC)` increases by exactly the purchase amounts.
- [ ] `setWallets` from a non-owner key reverts.
- [ ] USDC sent directly to the splitter (outside `distribute`) is recoverable
      per contract design — document the actual behavior for the auditor.

## Exit criteria

Signed audit report with all High/Critical findings resolved.
