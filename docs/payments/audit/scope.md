# RevenueSplitter — Audit Scope

**Target**: `contracts/revenue_splitter_stylus/` (Arbitrum Stylus, Rust → WASM)
**Deployed reference**: Arbitrum Sepolia `0x34fa204ca5db1a25a0003b1c7b45ab9c858d63bf`
**Freeze tag**: `revenue-splitter-audit-v1` (create at commissioning time)

## Role in the system

Receives USDC (Circle, EIP-3009) pushed by the x402 facilitator during
settlement and atomically fans out 80% creator / 10% platform / 10% protocol
via ERC-20 `transfer` calls. It is the only contract in the platform that
touches fee routing. It must never custody funds between transactions.

Callers: `settlePayment()` in `src/lib/x402/server.ts` submits
`transferWithAuthorization(payer → splitter)` then `distribute(token, creator, amount)`
in the same flow.

## Invariants to verify

1. **Conservation**: `creatorAmount + platformAmount + protocolAmount == amount`
   for every `distribute`; rounding remainder goes to `protocolWallet`, never
   lost or minted.
2. **Access control**: `initialize` callable once; `setWallets` owner-only;
   no function lets a non-owner redirect funds.
3. **No custody**: after `distribute`/`distributeAll` returns, the splitter's
   token balance attributable to that amount is zero.
4. **Reentrancy**: ERC-20 `transfer` targets are attacker-choosable via
   `creator` — verify state updates (`creatorEarnings`, `totalDistributed`)
   are consistent under reentrant calls; USDC is non-callback but the
   contract must not assume a specific token.
5. **Token handling**: behavior with fee-on-transfer / non-standard-return
   ERC-20s; behavior when `transfer` returns false vs reverts.
6. **Arithmetic**: bps math (`amount * bps / 10000`) overflow behavior with
   uint256 amounts; zero-amount and dust-amount calls.
7. **Stranded funds**: USDC sent directly to the contract outside
   `distribute` — is `distributeAll` the recovery path, and can it be abused
   to credit an attacker-chosen creator?
8. **Wallet update race**: `setWallets` mid-flight vs an in-progress
   settlement (front-running the facilitator's `distribute`).

## Threat model

- Malicious `creator` address (reentrancy, gas griefing, transfer revert DoS).
- Compromised facilitator key: can it misroute the 20% fee share?
  (Expected: no — wallets are contract state, not call parameters.)
- Owner key compromise: blast radius is limited to future fee wallets
  (`setWallets`), not creator funds.

## Known issues / accepted risks (pre-audit)

- Testnet wallets not yet hardened (Phase 1) — operational, not contract.
- `distribute` trusts the caller-supplied `creator`; correctness relies on
  the facilitator passing `drop.creator`. Documented design decision:
  authorization lives in the x402 layer, splitter is a pure fan-out.

## Deliverables requested from auditor

Findings report (severity-ranked), fix verification round, and a statement on
Stylus/WASM-specific risks (storage layout, cross-contract call semantics).
