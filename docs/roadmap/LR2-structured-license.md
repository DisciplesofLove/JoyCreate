# LR2 — Structured License Terms

**Status:** ✅ Done (as-built)
**Closes:** (licensing pillar — no numbered gap; required for "licensing assets")
**Depends on:** LR1 (identity + blueprint runtime node established).

---

## As-built (implemented)

- [src/lib/onchain/license.ts](../../src/lib/onchain/license.ts) — `LicenseTerms`
  type + `buildLicenseTerms` (pure builder, permissive defaults),
  `normalizeLicense` (object | SPDX string | nullish → terms shim),
  `checkLicense(terms, use, now?)` predicate (commercial / derivative /
  runtimeExecution + expiry), and `hashLicenseTerms` (deterministic keccak256
  over canonical sorted-key JSON). Schema id `joy-license/1.0`.
- [src/lib/joymarketplace/publish_orchestrator.ts](../../src/lib/joymarketplace/publish_orchestrator.ts) —
  `PublishInput.licenseTerms?` added; `buildMetadata` pins the structured
  `licenseTerms` + `licenseHash` into drop metadata while keeping a legacy
  `license` SPDX string for older consumers. Terms win over the legacy string.
- [src/lib/onchain/interface_broker.ts](../../src/lib/onchain/interface_broker.ts) —
  `BlueprintLicense` node + optional `license?` field on `InterfaceBlueprint`;
  `buildDropBlueprint(chain, dropId, { license })` projects terms (+ hash) onto
  the blueprint.
- [src/lib/joymarketplace/publish_and_monetize.ts](../../src/lib/joymarketplace/publish_and_monetize.ts) —
  passes the publish input's normalized license into `buildDropBlueprint`.
- Tests: [src/__tests__/license.test.ts](../../src/__tests__/license.test.ts)
  (11) + updated [src/__tests__/publish_and_monetize.test.ts](../../src/__tests__/publish_and_monetize.test.ts).
  On-chain mint gating of the **runtime-execution** right is deferred to LR3 (PoU).

---

## Goal

Replace the flat `license: "CC-BY-4.0"` string in the publish path with a
**structured license object** that is (a) committed into drop metadata, (b)
exposed as a `license` node on the ERC-1144 blueprint, and (c) enforced at
mint / Proof-of-Use time. This is the "licensing" half of the Licensed Runtime
Asset.

---

## License object (proposed schema)

A small, hash-committed JSON object (pinned alongside drop metadata):

- `id` — license identifier (e.g. `"joy/commercial-runtime/1.0"`).
- `spdx` — optional SPDX id for human-readable licenses (`"CC-BY-4.0"`, `"MIT"`).
- `commercial` — boolean: commercial use allowed.
- `derivative` — boolean: derivative works allowed.
- `runtimeExecution` — boolean: the buyer may execute the asset's `skillCID`
  locally (the bridge to the runtime pillar / LR8).
- `expiry` — optional ISO timestamp or `null` for perpetual.
- `seats` — optional integer for per-seat licensing, `null` = unlimited per mint.
- `termsUri` — optional `ipfs://` pointer to full legal text.

Keep it minimal and additive; unknown fields ignored by older consumers.

---

## Work

1. **Schema + builder** — add a `license.ts` (sibling to `agent_card.ts`, likely
   `src/lib/onchain/license.ts`) with a `LicenseTerms` type and
   `buildLicenseTerms(input)` pure builder + a `normalizeLicense(legacyString)`
   shim that maps the existing `license` string to a `LicenseTerms`.
2. **Publish path** — extend
   [PublishAndMonetizeInput](../../src/lib/joymarketplace/publish_and_monetize.ts)
   and the underlying `PublishInput` to accept a `license` object (default derived
   from the legacy string). Commit a license hash into the drop metadata and pin
   the full license JSON.
3. **Blueprint** — add `BlueprintLicense` and an optional `license?` node to
   [InterfaceBlueprint](../../src/lib/onchain/interface_broker.ts); populate in
   `buildDropBlueprint` (and store/agent where applicable). The license becomes
   part of what a consumer reads before paying.
4. **Enforcement hook (app/MCP layer)** — add a `checkLicense(terms, requestedUse)`
   predicate used by the purchase/runtime paths; reject when the requested use
   (e.g. `runtimeExecution`) is not permitted. On-chain mint gating for the
   runtime-execution flag is deferred to LR3 (PoU) to avoid a contract redeploy.

---

## Manual verification (Arbitrum Sepolia)

1. Publish an asset with a structured license (e.g. `commercial: false,
   runtimeExecution: true`).
2. Drop metadata JSON contains the license object/hash; the pinned license CID
   resolves on IPFS.
3. `buildDropBlueprint` returns a `license` node matching the terms.
4. A mint/purchase requesting a forbidden use (e.g. commercial) is **rejected**
   at the app/MCP layer with a clear error; an allowed use proceeds.

---

## Decisions

- License lives in **metadata + blueprint**, not a new contract (keeps glue thin
  per LR0 decision #3). Integrity = hash committed in drop metadata.
- Enforcement is **app/MCP-layer first**; on-chain PoU gating only for the
  `runtimeExecution` right, added in LR3.

## Notes for next milestone

- LR3 will tie `runtimeExecution: true` to a `grantProof` after purchase, making
  the license enforceable on-chain for the execution right specifically.
