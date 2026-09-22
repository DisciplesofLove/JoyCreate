# Phase 6 — zk Settlement Awareness

Reference: [ZK Settlement is Coming to Arbitrum](https://blog.arbitrum.io/zk-settlement-is-coming/)

## What Arbitrum zk settlement is

Arbitrum is adding zero-knowledge validity proofs to **BoLD**, its settlement
protocol toward Ethereum, in a multi-proving model (ZK proofs alongside the
existing optimistic fraud proofs). The headline effect: L2→L1 asset settlement
drops from the ~7-day challenge window to **hours**. Stylus execution is
included in the prover, so this repo's Stylus contracts are covered.

## Why there is no app integration work

zk settlement is a **chain-level upgrade**. It changes how Arbitrum proves its
state to Ethereum L1 — not how transactions execute on L2. Our purchases:

- confirm on Arbitrum in seconds (soft finality) — unchanged;
- become withdrawable/settled on Ethereum L1 (hard finality) — this is the
  window zk settlement shrinks from days to hours.

The x402 rail, RevenueSplitter, and EditionController run entirely on L2 and
inherit the upgrade automatically. Building app-level zk proving (e.g. zk
payment receipts) would duplicate the rollup's own proof system for no
security gain — deliberately out of scope.

## What we ship instead

1. This document.
2. A **settlement finality** note in the purchase receipt UI (Phase 3):
   - "Confirmed on Arbitrum" — the settle/mint txs are final on L2.
   - "Settles to Ethereum" — hard finality; copy notes Arbitrum's zk
     settlement upgrade reduces this window from days to hours.

## Monitoring trigger

When Arbitrum ships zk settlement on Arbitrum One, update the receipt copy
(remove "coming") — nothing else changes. Track via the Arbitrum blog and
ArbOS release notes.
