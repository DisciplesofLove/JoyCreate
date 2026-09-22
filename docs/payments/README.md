# Payments Program — Real 80/10/10 Revenue Splits

How a purchase price is distributed, what is already live, and the phased path
to an audited mainnet rail.

## Where the price goes (example: $3.00 USDC edition)

| Bucket | Share | Amount | On-chain recipient |
|---|---|---|---|
| **Seller** (creator) | 80% | $2.40 | `drop.creator` — the wallet that created the drop |
| **Compute** (protocol / Lit fee) | 10% | $0.30 | RevenueSplitter `protocolWallet` |
| **Platform + DAO** (shared treasury) | 10% | $0.30 | RevenueSplitter `platformWallet` |

The split is executed **atomically on-chain** by the `RevenueSplitter` Stylus
contract during x402 settlement — it is *not* an off-chain preview on chains
where the splitter is deployed. On chains where it is not deployed
(`arbitrumOne` today), purchases are unavailable and UI must show the
"Preview only" caption.

Machine-readable source of truth: [split-config.json](split-config.json).
Deployment records: [deployments.json](deployments.json).
Phase tracker: [roadmap.json](roadmap.json).

**Launching the MVP?** See [LAUNCH.md](LAUNCH.md) — what ships now, what is
deferred post-launch, and the pre-launch checklist.

## Settlement rail (already live on Arbitrum Sepolia)

```
buyer signs EIP-3009 TransferWithAuthorization (gasless, EIP-712)
  → facilitator submits transferWithAuthorization: USDC → RevenueSplitter
  → RevenueSplitter.distribute(token, creator, amount): atomic 80/10/10
  → EditionController.mint(dropId) → tokenId
```

Code path: `src/lib/x402/purchase_orchestrator.ts` → `src/lib/x402/server.ts`
(`settlePayment`) → `contracts/revenue_splitter_stylus/`.

## Phases

| Phase | Doc | Status |
|---|---|---|
| 1. Wallet & config hardening | [phase-1-wallet-hardening.md](phase-1-wallet-hardening.md) | code ready — **needs wallet provisioning + `set_wallets.cjs` run** |
| 2. Per-store payout address | [phase-2-payout-address.md](phase-2-payout-address.md) | implemented |
| 3. Checkout UI "Where the price goes" | [phase-3-checkout-ui.md](phase-3-checkout-ui.md) | implemented |
| 4. Audit readiness | [phase-4-audit-readiness.md](phase-4-audit-readiness.md) | scope package written — **audit not commissioned** |
| 5. Mainnet gate (Arbitrum One) | [phase-5-mainnet-gate.md](phase-5-mainnet-gate.md) | **blocked on Phase 4 audit** |
| 6. zk settlement awareness | [phase-6-zk-settlement.md](phase-6-zk-settlement.md) | documented; no app work required |

## Invariants (must always hold)

1. `creator + platform + protocol == amount` for every `RevenueSplit` event
   (rounding remainder goes to protocol).
2. Basis points in `split-config.json`, `src/config/x402.ts`
   (`REVENUE_SPLIT_BPS`) and the on-chain contract config are identical.
3. Contracts never hold fee balances between calls — x402 routes and the
   splitter fans out within the settlement transaction.
4. Only the splitter `owner` can call `setWallets`.
5. Mainnet deployment requires a completed independent audit (Phase 4/5).
