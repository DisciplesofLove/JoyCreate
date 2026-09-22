# LR7 — Arbitrum One Mainnet Cutover + GA

**Status:** 🟡 Code-ready (awaiting out-of-band mainnet deploy)
**Closes:** G7 (mainnet not live — all `arbitrumOne` addresses are `ZERO_ADDRESS`)
**Depends on:** LR1–LR6 (capabilities mature on testnet first).

---

## As-built (code-ready cutover)

The cutover is now **config-only** — no code change is needed once the contracts
are deployed. All `arbitrumOne` addresses across the 5 configs read an env
override (falling back to `ZERO_ADDRESS`, which keeps each readiness predicate
false until a real address is supplied):

- [src/config/env_address.ts](../../src/config/env_address.ts) — `envAddress(key, fallback)`
  reads `import.meta.env` (Vite renderer) → `process.env` (Electron main) → fallback.
  Dependency-free; safe in both bundles.
- [erc8004.ts](../../src/config/erc8004.ts) — `VITE_IDENTITY_REGISTRY_ARB_ONE`,
  `VITE_REPUTATION_REGISTRY_ARB_ONE`, `VITE_VALIDATION_REGISTRY_ARB_ONE`.
- [glue.ts](../../src/config/glue.ts) — `VITE_STORE_REGISTRY_ARB_ONE`,
  `VITE_EDITION_CONTROLLER_ARB_ONE`, `VITE_AGENT_MANDATE_ARB_ONE`.
- [x402.ts](../../src/config/x402.ts) — `VITE_REVENUE_SPLITTER_ARB_ONE`,
  `VITE_REGISTRATION_FEE_RECIPIENT_ARB_ONE` (Arb One USDC already in code).
- [data_market.ts](../../src/config/data_market.ts) — `VITE_DATA_PROVENANCE_ARB_ONE`,
  `VITE_DATA_LEASE_ARB_ONE`.
- [optimistic_staking.ts](../../src/config/optimistic_staking.ts) — `VITE_OPTIMISTIC_STAKING_ARB_ONE`.
- Subgraph endpoints already env-overridable in [subgraphs.ts](../../src/config/subgraphs.ts)
  (`VITE_DROP_SUBGRAPH_ARB_ONE`, `VITE_STORES_SUBGRAPH_ARB_ONE`, `VITE_MARKETPLACE_SUBGRAPH_ARB_ONE`).
- Operator template: [.env.arbitrum-one.example](../../.env.arbitrum-one.example).
- Tests: [env_address.test.ts](../../src/__tests__/env_address.test.ts) (3) — precedence + empty-as-unset.

Once the env values are set, `isGlueReady("arbitrumOne")`,
`isX402Ready("arbitrumOne")`, `isErc8004Ready("arbitrumOne")` and
`isDataMarketReady("arbitrumOne")` flip to true automatically.

### ⛔ Still requires a human (out-of-band)

These cannot be automated from the app and are the remaining LR7 work:

1. **Deploy the Stylus + glue + ERC-8004 + x402 + data-market + staking contracts
   to Arbitrum One** (real signer keys + gas; never commit keys). Record addresses.
2. **Fill the env file** above with the deployed addresses and restart.
3. **Redeploy the LR6 subgraph** against Arbitrum One (manual; see
   [subgraph/README.md](../../subgraph/README.md)) and set the `*_ARB_ONE` URLs.
4. **Run the mainnet GA verification** (LR1–LR6 flows + a real small USDC purchase).

---

## Goal

Deploy the full Stylus + glue + ERC-8004 + x402 stack to **Arbitrum One**, fill
the mainnet addresses in config, redeploy subgraphs, and run the complete
end-to-end verification on mainnet for GA.

---

## The 5 config files with `arbitrumOne: ZERO_ADDRESS`

- [src/config/erc8004.ts](../../src/config/erc8004.ts) — Identity / Reputation / Validation
- [src/config/glue.ts](../../src/config/glue.ts) — StoreRegistry / EditionController / AgentMandate
- [src/config/x402.ts](../../src/config/x402.ts) — RevenueSplitter (+ Arb One USDC `0xaf88d065…` already present)
- [src/config/data_market.ts](../../src/config/data_market.ts) — DataProvenance
- [src/config/optimistic_staking.ts](../../src/config/optimistic_staking.ts) — staking

---

## Work

1. **Deploy contracts** to Arbitrum One following the existing Stylus deploy
   scripts/pattern (ruint pinned `=1.16.0`; `wasm-opt --enable-bulk-memory
   --enable-sign-ext`). Record each address.
2. **Fill config** — replace each `arbitrumOne: ZERO_ADDRESS` with the deployed
   address. Confirm `isGlueReady("arbitrumOne")`, `isX402Ready("arbitrumOne")`,
   `isErc8004Ready("arbitrumOne")` all return true.
3. **Subgraphs** — redeploy the LR6 subgraphs against Arbitrum One (manual flag).
4. **USDC** — verify Arb One USDC (`0xaf88d065e77c8cC2239327C5EDb3A432268e5831`)
   EIP-3009 path through x402 server.
5. **GA checklist** — run the full LR1–LR6 verification on mainnet.

---

## Manual verification (Arbitrum One)

1. Repeat LR1–LR6 verifications on mainnet (identity mint, store reg, drop,
   purchase, PoU, feedback, fee split, subgraph, ENS↔slug).
2. All three readiness predicates true for `arbitrumOne`.
3. A real (small) USDC purchase settles and splits correctly via RevenueSplitter.

---

## Decisions

- Mainnet is **last** (LR0 ordering) — capabilities harden on Sepolia first.
- Deploy keys / signers handled out-of-band; never commit private keys.

## Notes for next milestone

- LR8 (local execution) is chain-agnostic and can land before or after GA.
