# MVP Launch Posture — Payments

What ships at MVP launch, what is deliberately deferred, and the exact
resume-point for post-launch work. Companion machine-readable file:
[roadmap.json](roadmap.json).

## What ships at MVP (works today, no further action)

| Capability | State |
|---|---|
| x402 purchase rail (EIP-3009 USDC → RevenueSplitter → mint) | **Live on Arbitrum Sepolia** |
| Atomic 80/10/10 on-chain split (`RevenueSplit` event per purchase) | **Live on Arbitrum Sepolia** |
| "Where the price goes" breakdown + Buy flow (8004scan drop blueprints) | **Live** — badge shows "Split enforced on-chain" |
| Preview-only caption on chains without the splitter (Arbitrum One) | **Live** — automatic via `isX402Ready()` |
| Payout address setting + publish-time mismatch warning | **Live** |
| `x402:status` drift visibility (on-chain wallets vs config) | **Live** |

## Known limitations at launch (disclosed, accepted for MVP)

1. **Testnet only.** Purchases settle on Arbitrum Sepolia. Arbitrum One shows
   the Preview caption and cannot purchase.
2. **Fee wallets not hardened.** Compute and Platform+DAO buckets currently
   pay the same testnet address (`0x5939...B9FE`). Split math is correct;
   destinations await Phase 1.
3. **Contract unaudited.** Fine for testnet; the audit is the mainnet gate.
4. **Per-drop payout is immutable.** `drop.creator` = signing wallet at
   `createDrop()`; the app warns on mismatch but cannot change it later.

None of these block launch: the UI is honest about each (Preview caption,
status surface, publish warning).

## Pre-launch checklist

- [ ] `npm run lint` and unit tests green.
- [ ] One manual Sepolia purchase: breakdown amounts == `RevenueSplit` event
      amounts (checklist in [phase-3-checkout-ui.md](phase-3-checkout-ui.md)).
- [ ] Settings → Joy Marketplace shows store slug + payout address inputs.
- [ ] Switch chain to Arbitrum One: Buy disabled, Preview caption visible.

## Deferred to post-MVP (ordered resume-point)

| # | Work item | Doc | Blocker |
|---|---|---|---|
| 1 | Provision `computeWallet` + Platform+DAO treasury Safe | [phase-1](phase-1-wallet-hardening.md) | wallets are a human/legal decision |
| 2 | Run `set_wallets.cjs`; update deployments.json + split-config.json | [phase-1](phase-1-wallet-hardening.md) | needs #1 + owner key |
| 3 | Commission RevenueSplitter audit (scope ready) | [phase-4](phase-4-audit-readiness.md), [audit/scope.md](audit/scope.md) | budget/vendor selection |
| 4 | Resolve findings, re-review, sign-off | [audit/findings.md](audit/findings.md) | needs #3 |
| 5 | Deploy splitter + glue to Arbitrum One, init with mainnet Safe | [phase-5](phase-5-mainnet-gate.md) | **hard-gated on #4** |
| 6 | Flip split-config.json `arbitrumOne.status` to `live`; mainnet smoke purchase | [phase-5](phase-5-mainnet-gate.md) | needs #5 |
| 7 | Update receipt copy when Arbitrum ships zk settlement | [phase-6](phase-6-zk-settlement.md) | external — monitor Arbitrum blog |

No code changes are required to resume: items 1–2 are scripts/ops, 3–4 are
procurement, 5–6 use the existing deploy pattern + config constants, and the
UI flips from Preview to Live automatically once addresses land in
`src/config/x402.ts`.
