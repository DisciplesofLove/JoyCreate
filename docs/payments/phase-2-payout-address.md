# Phase 2 — Per-Store Payout Address

## Goal

Make the Seller bucket destination explicit and auditable. The creator payout
is `drop.creator` on the EditionController — set immutably per drop at
`createDrop()` time from the signing wallet. This phase makes that visible and
warns when it diverges from the creator's intended payout address.

## Design

- New optional setting `marketplacePayoutAddress` (settings schema,
  `src/lib/schemas.ts`). This is the address the creator *intends* to receive
  the 80% Seller bucket at.
- `publishAndMonetize` compares the signing wallet against the configured
  payout address before `createDrop()` and records a warning on mismatch —
  the drop's creator would be the signer, not the configured address.
- `x402:status` returns the configured payout address so UI can display it.

## Explicit non-goals

- **Changing a drop's payout after creation.** `drop.creator` is immutable
  per-drop on-chain. Mutable payouts require an EditionController/
  RevenueSplitter v2 and are out of scope.
- Custodial payout routing — the app never holds funds.

## Verification checklist (manual)

- [ ] Set `marketplacePayoutAddress` in settings; `x402:status` echoes it.
- [ ] Publish with a signer that matches: no warning in outcome errors.
- [ ] Publish with a mismatched signer: outcome contains a
      `payout-mismatch` warning naming both addresses; drop still created.

## Exit criteria

Creators can see and pre-verify where their 80% will settle before publishing.
