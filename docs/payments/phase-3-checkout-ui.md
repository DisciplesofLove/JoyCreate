# Phase 3 — Checkout UI: "Where the price goes"

## Goal

Show buyers the exact split before purchase, and the settled amounts after —
replacing the old "Preview only" placeholder wherever the split is live.

## Design

- `PurchaseBreakdown` component (`src/components/marketplace/PurchaseBreakdown.tsx`):
  - Rows: **Seller (80%)** / **Compute (10%)** / **Platform + DAO (10%)** with
    USDC amounts computed by the same integer-bps math the contract uses
    (remainder → Compute).
  - **Live badge** ("Split enforced on-chain") when `x402:status.ready` is
    true for the active chain.
  - **Preview caption** ("Preview only — the on-chain split contract isn't
    deployed on this network, so this purchase currently settles in full to
    the store's configured payout address.") when the splitter is
    `ZERO_ADDRESS` (Arbitrum One today).
- Purchase surface: the drop blueprint view in 8004scan
  (`src/pages/Erc8004ScanPage.tsx`) gets the breakdown plus a **Buy** button
  wired to `x402:purchase-edition` via `useX402PurchaseEdition`.
- Receipt: settle + mint tx hashes with explorer links, token id, and the
  settlement-finality note (see phase 6).

## Data flow

```
Erc8004ScanPage (drop blueprint, priceUsdc)
  → useX402Status(chain)      — live/preview + on-chain split config
  → PurchaseBreakdown         — bps math, badges
  → useX402PurchaseEdition()  — useMutation → x402:purchase-edition
  → receipt (PurchaseResult: settlement.txHash, mintTxHash, tokenId)
```

## Verification checklist (manual, Sepolia)

- [ ] Drop priced $3.00 shows Seller $2.40 / Compute $0.30 / Platform+DAO $0.30.
- [ ] Live badge on Arbitrum Sepolia; Preview caption when switched to
      Arbitrum One.
- [ ] Buy completes: receipt shows settle tx + mint tx; explorer confirms the
      `RevenueSplit` event amounts equal the displayed breakdown.
- [ ] Odd price (e.g. $0.01) — remainder credits Compute; UI totals still sum
      to the price.

## Exit criteria

No purchase happens without the buyer seeing the true split; receipts link to
verifiable on-chain settlement.
