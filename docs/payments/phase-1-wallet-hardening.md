# Phase 1 — Wallet & Config Hardening (Arbitrum Sepolia)

## Goal

Stop paying the Compute (protocol) and Platform+DAO buckets to the same testnet
address. After this phase, a purchase pays **three distinct addresses**.

## Current state

`RevenueSplitter.getConfig()` on Arbitrum Sepolia returns
`platformWallet == protocolWallet == 0x5939229582A5b42A6C5f55Fe55eC47523Cd5B9FE`
(the deployer). The 80/10/10 math is correct; the destinations are not.

## Tasks

1. **Provision wallets** (developer action — cannot be automated):
   - `computeWallet` — receives the 10% Compute / Lit fee bucket.
   - `platformDaoTreasury` — a multisig Safe shared by platform + DAO,
     receives the 10% Platform + DAO bucket.
2. **Run the wallet update script** (owner key required in
   `contracts/revenue_splitter_stylus/.pk.txt`):

   ```sh
   node contracts/revenue_splitter_stylus/set_wallets.cjs \
     0x34fa204ca5db1a25a0003b1c7b45ab9c858d63bf \
     <platformDaoTreasury> <computeWallet>
   ```

   The script calls `setWallets(platformWallet, protocolWallet)` and prints
   `getConfig()` before/after.
3. **Update records**: set the new addresses and `"walletsHardened": true` in
   [deployments.json](deployments.json) and [split-config.json](split-config.json).
4. **Config cleanup** (done in code): the legacy, unused Polygon
   `REVENUE_SPLITTER` entries were removed from `src/config/joymarketplace.ts`
   — the only live splitter config is `src/config/x402.ts`.
5. `x402:status` now surfaces the on-chain splitter config (wallets + bps) so
   drift between config and chain is visible in the app.

## Verification checklist (manual, Sepolia)

- [ ] `set_wallets.cjs` prints the two new distinct addresses from `getConfig()`.
- [ ] `x402:status` in the app reports the same wallets.
- [ ] Test purchase of a priced drop: the settle tx contains a `RevenueSplit`
      event and three USDC `Transfer`s to **three different addresses**.
- [ ] Amounts match `computeSplit()`: for $3.00 → 2.40 / 0.30 / 0.30.

## Exit criteria

Three distinct recipients on Sepolia, records updated, no config drift.
