# LR1 — Identity + Agent-Card Runtime Manifest

**Status:** ✅ Done (Arbitrum Sepolia path implemented + unit-tested)
**Closes:** G1 (store creation never minted an identity), G2 (no agent-card / IPLD CID)
**Depends on:** nothing — this is the foundation for both pillars.

---

## Goal

When a store is auto-registered during publish, **mint (or reuse) an ERC-8004
identity** whose `agentDomain` is the **IPFS CID of an agent card** — a small JSON
runtime manifest carrying `modelConfig` / `systemPrompt` / `toolsSchema` /
`skillCID`. Surface that runtime pointer on the ERC-1144 blueprint so consumers
can discover and (later) execute the asset.

This fuses the brief's agent-card shape with JoyCreate's deployed Identity
Registry + multi-provider IPFS pinner.

---

## What was built

### New module — [src/lib/onchain/agent_card.ts](../../src/lib/onchain/agent_card.ts)

- `buildAgentCard(input)` — pure builder. Emits the brief's card shape:
  `{ name, version "1.0", platform "JoyCreate", type, modelConfig, systemPrompt,
  toolsSchema, skillCID, identity{storeLabel, owner}, chainId }`. Runtime fields
  default to `null`. `chainId` comes from `ERC8004_CHAIN_IDS[chain]`.
- `pinAgentCard(card, {keys?})` — pins via
  [IpfsPinner](../../src/lib/joymarketplace/ipfs_pinner.ts) (4everland → Pinata →
  Helia). Returns `{ cid, uri, pinnedRemotely }`; warns when only local Helia.
- `ensureStoreIdentity(wallet, input)` — **the composition entry point.** Reuses
  an existing identity for the wallet via `resolveByAddress` (no duplicate mint);
  otherwise builds + pins a card and calls `registerAgent` (`newAgent(domainBytes,
  address)`) with the card CID as `agentDomain`. Returns `{ agentId, agentCardCid,
  agentCardUri, minted, reused, txHash }`.
- `agentDomainToCardCid(domain)` — recognizes CIDv0 (`Qm…`) / CIDv1 (`bafy…`),
  strips `ipfs://`. Used by the broker to expose a `runtime` node only when the
  domain is a card CID (legacy plain-text domains return `undefined`).

### Wiring — [src/lib/joymarketplace/publish_and_monetize.ts](../../src/lib/joymarketplace/publish_and_monetize.ts)

In the auto-register branch (only when a store doesn't already exist):

- An explicit `input.agentId` (≠ `"0"`) wins and is used as-is.
- Otherwise `ensureStoreIdentity` mints/reuses an identity; the resulting
  `agentId` is passed into `registerStore` (previously hard-coded `"0"`).
- Identity-mint failure is **non-fatal**: the store still registers with
  `agentId "0"` and an `identity: …` entry is pushed to `errors`.
- `PublishAndMonetizeOutcome` gained `agentId?` and `agentCardCid?`.

### ERC-1144 blueprint — [src/lib/onchain/interface_broker.ts](../../src/lib/onchain/interface_broker.ts)

- New `BlueprintRuntime { agentCardCid, agentCardUri }` interface and optional
  `runtime?` field on `InterfaceBlueprint`.
- `resolveRuntime(identity)` derives it from the identity's `agentDomain` via
  `agentDomainToCardCid`.
- Populated in `buildDropBlueprint`, `buildStoreBlueprint`, `buildAgentBlueprint`.

### Tests

- [src/__tests__/agent_card.test.ts](../../src/__tests__/agent_card.test.ts) — `buildAgentCard`
  shape (defaults + runtime overrides); `agentDomainToCardCid` CIDv0/CIDv1/legacy.
- [src/__tests__/publish_and_monetize.test.ts](../../src/__tests__/publish_and_monetize.test.ts) —
  updated: happy path asserts minted `agentId "5"` + `agentCardCid` bound to the
  store; new tests for identity-failure fallback (store still registers with `"0"`,
  `identity:` error) and explicit-agentId pass-through (no mint).

All `npm run test` targets for these two files pass; `npx oxlint` clean; no TS errors.

---

## Key signatures relied on (verified in code)

- `registerAgent(wallet, { chain, agentDomain, agentAddress })` →
  `{ agentId, txHash, blockNumber }`. Requires `agentAddress === wallet.address`.
  Domain stored as UTF-8 bytes via `newAgent`. Parses `AgentRegistered` event.
- `resolveByAddress(chain, address)` → `agentId` string (`"0"` if none).
- `registerStore(wallet, { chain, slug, agentId })` — slug → bytes; emits
  `StoreRegistered`.
- `IpfsPinner.pinJson(obj, name?)` → `PinResult { cid, url, pinnedRemotely,
  provider, size? }`.

---

## Manual verification (Arbitrum Sepolia)

1. Configure a funded secp256k1 chain key and `marketplaceStoreSlug` in Settings.
2. Publish an asset to a **new** store slug via the publish path.
3. Confirm on Arbitrum Sepolia explorer: an `AgentRegistered` event **and** a
   `StoreRegistered` event in the same flow, with the store's `agentId` matching
   the minted identity.
4. `getAgent(agentId).agentDomain` decodes to a CID; fetch
   `https://ipfs.io/ipfs/<cid>` → the agent-card JSON with the runtime fields.
5. The identity is visible on 8004scan.
6. Re-publish to a second slug from the **same wallet** → identity is **reused**
   (no second `AgentRegistered`), `ensureStoreIdentity` returns `reused: true`.
7. `buildDropBlueprint(chain, dropId)` returns a `runtime` node with the card CID.

---

## Notes / follow-ups for later milestones

- Runtime manifest fields are all `null` today (store cards). LR4/LR5 populate
  `toolsSchema` / `systemPrompt` for agent cards; LR8 consumes `skillCID`.
- `ensureStoreIdentity` currently keys reuse purely by controlling address. If one
  wallet should own multiple distinct identities, add an explicit override path.
- A backfill for **already-registered** stores (identity = `"0"`) is not yet
  built — add a one-shot maintenance command if needed before GA.
- LR2 will add a sibling `license` node to the same blueprint.
