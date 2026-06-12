# LR11 — Phase 2: Skill Authoring + Pinning Pipeline

**Status:** ✅ Done (as-built)
**Track:** A (Agentic Runtime)
**Closes:** the LR8/LR9/LR10 "needs a pinned bundle whose CID is the agent's
`skillCID`" gap — makes the runtime usable end to end.
**Depends on:** LR9/LR10 (skill kinds), LR1 (agent card + pinner),
`erc8004_client.updateAgent`.

---

## As-built (implemented)

A one-shot pipeline that turns author-supplied fields into a live, runnable
skill: build + validate → pin → attach to card → re-pin → point the ERC-8004
`agentDomain` at the new card.

- **Authoring library** — [src/lib/onchain/skill_authoring.ts](../../src/lib/onchain/skill_authoring.ts):
  - `buildSkillBundle(input)` — constructs a bundle and runs it through the
    runtime's own `parseSkillBundle`, so an author can never pin a bundle the
    runtime would later reject (same validation + clamping).
  - `authorAndPinSkill(input, deps?)` — builds, validates, and pins the bundle
    via an injectable `PinJsonFn` (default: the multi-provider `IpfsPinner`),
    returning `{ skillCid, skillUri, pinnedRemotely, bundle }`.
  - `publishSkillToAgent(wallet, input, deps?)` — authors + pins the skill,
    resolves the agent (asserting the wallet controls it), fetches its current
    card (or builds a fresh one when the `agentDomain` isn't a CID), writes
    `skillCID`, re-pins the card, and calls `updateAgent` to repoint the
    identity. Pinning and IPFS reads are injectable for tests.
- **IPC channel** — [src/ipc/handlers/erc8004_handlers.ts](../../src/ipc/handlers/erc8004_handlers.ts):
  `erc8004:publish-skill` loads the active signing wallet (`jcnKeyManager`) and
  calls `publishSkillToAgent`. Throws on error per repo convention. Wired through
  the full IPC contract:
  [src/preload.ts](../../src/preload.ts) allowlist + `erc8004PublishSkill` in
  [src/ipc/ipc_client.ts](../../src/ipc/ipc_client.ts) (with
  `Erc8004AuthorSkillInput` / `Erc8004PublishSkillResult` types).
- **MCP tool** — [src/mcp_server/tools/web4_marketplace_tools.ts](../../src/mcp_server/tools/web4_marketplace_tools.ts):
  `skill_publish` maps natural-language params to a `kind`-discriminated skill
  and calls the IPC handler — so an external agent can author and publish a
  skill, then `runtime_invoke` it.

**Tests:** [src/__tests__/skill_authoring.test.ts](../../src/__tests__/skill_authoring.test.ts)
(7 — build/validate/clamp, pin, full publish flow, control-check refusal, and
fresh-card path). All pass; oxlint clean.

---

## Goal

Make a Licensed Runtime Asset runnable without hand-pinning JSON: author a skill,
pin it, and bind it to the agent's on-chain identity in one operation.

---

## Work

1. `skill_authoring.ts`: `buildSkillBundle`, `authorAndPinSkill`,
   `publishSkillToAgent` (injectable pin + fetch).
2. `erc8004:publish-skill` IPC channel (handler + ipc_host registration +
   preload allowlist + ipc_client method + types).
3. `skill_publish` MCP tool.

---

## Manual verification

1. `skill_publish` with a `prompt-agent` (or tool/code) skill returns a new
   `skillCid` + `cardCid` + tx hash.
2. `erc8004:get-agent` shows the `agentDomain` now points at the new card CID.
3. `runtime_invoke` with `input` resolves the new `skillCID` and executes it.
4. Publishing with a wallet that does not control the agent is **refused**.

---

## Decisions

- Authoring reuses the runtime's `parseSkillBundle` — one validation path for
  both authoring and execution.
- The publishing wallet **must control** the agent (address check) before any
  on-chain write.
- Pinning + IPFS reads are injectable so the orchestration is unit-tested
  without network or a real pinner.

## Notes

- Chain-agnostic; ships on Sepolia and carries to mainnet unchanged.
