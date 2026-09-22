# LR8 — Phase 2: IPLD Local Model Execution

**Status:** ✅ Done (as-built)
**Closes:** the runtime payoff (no numbered gap — this is the "runtime asset" endgame)
**Depends on:** LR1 (agent card + `skillCID`), LR2 (`runtimeExecution` license), LR3 (PoU), LR5 (`runtime_invoke`).

---

## As-built (implemented)

The resolve → gate → execute pipeline ships as injectable, unit-tested libs and
is wired behind the LR5 `runtime_invoke` MCP tool.

- **IPFS retrieval** — [src/lib/ipfs/ipfs_fetch.ts](../../src/lib/ipfs/ipfs_fetch.ts):
  `fetchIpfsBytes` / `fetchIpfsJson` loop the public `IPFS_GATEWAYS` with a
  per-request `AbortController` timeout and a 5 MiB byte cap (rejects oversize via
  declared `content-length` or measured body). CIDs validated through
  `extractIpfsHash`. JSON is parsed, never evaluated.
- **PoU read wrapper** — [src/lib/onchain/glue_client.ts](../../src/lib/onchain/glue_client.ts):
  added `isProofGranted(chain, dropId, account)` to read the on-chain
  `EditionController.isProofGranted` grant.
- **Skill runtime core** — [src/lib/onchain/skill_runtime.ts](../../src/lib/onchain/skill_runtime.ts):
  - `parseSkillBundle` — validates an untrusted JSON doc as a **declarative**
    `joy-skill/1.0` `prompt-agent` manifest (`modelId` + `systemPrompt` +
    optional `promptTemplate`/`maxTokens`/`temperature`). Never executable code.
  - `resolveSkill(chain, agentId)` — `getAgent` → `agentDomain` →
    `agentDomainToCardCid` → fetch card → read `skillCID` → fetch + validate
    bundle.
  - `assertRuntimeGate(...)` — throws unless the license grants
    `runtimeExecution` (LR2) **and**, for a PoU-gated drop, `isProofGranted` is
    true for the buyer (LR3).
  - `executeSkill(skill, input, {infer})` — 32 000-char input cap, prompt
    templating, runs through an injected `InferenceFn` (defaults to a lazy import
    of `localModelManager.inference`, keeping Electron out of the test graph).
  - `invokeSkillRuntime(...)` — orchestrates gate → resolve → execute.
- **`runtime_invoke` upgrade** —
  [src/mcp_server/tools/web4_marketplace_tools.ts](../../src/mcp_server/tools/web4_marketplace_tools.ts):
  new optional `input` / `dropId` / `buyer` params. With `input`, it fetches the
  `skillCID` bundle and executes locally (`executionMode: "local-ipld (LR8)"`),
  returning the produced output; without `input` it keeps the LR5 manifest-only
  pointer response.

**Tests:** [src/__tests__/ipfs_fetch.test.ts](../../src/__tests__/ipfs_fetch.test.ts) (7),
[src/__tests__/skill_runtime.test.ts](../../src/__tests__/skill_runtime.test.ts) (17),
plus an LR8 execution case added to
[src/__tests__/web4_marketplace_tools.test.ts](../../src/__tests__/web4_marketplace_tools.test.ts) (11 total). All pass; oxlint clean.

**Deferred:** end-to-end execution requires (a) a loaded local model in
`localModelManager` and (b) a pinned skill bundle whose CID is recorded as the
agent's `skillCID`. Tool-call execution (`toolsSchema` wiring into the
inference loop) is left declarative for a follow-up; the current runtime executes
the prompt-agent manifest only.

---

## Goal

Execute a purchased asset's **`skillCID`** locally. The agent card pinned in LR1
becomes a runnable agent: the runtime fetches the skill bundle from IPFS and runs
it, gated by the LR2 `runtimeExecution` license right and the LR3 Proof-of-Use.

This is the "best of both" endgame — a licensed asset that is also an executable
runtime, with on-chain identity, payment, and provenance behind it.

---

## Work

1. **Skill resolution** — given a purchased drop, resolve its identity →
   `agentDomain` (card CID, via `agentDomainToCardCid`) → fetch the agent card →
   read `skillCID`. Fetch + verify the skill bundle from IPFS.
2. **License + PoU gate** — before executing, confirm the buyer holds the
   `runtimeExecution` right (LR2) and the on-chain PoU grant (LR3). Refuse
   otherwise.
3. **Local execution sandbox** — execute the skill (model config + system prompt +
   tools schema from the card). Reuse the existing MCP sandbox
   ([bin/joy-mcp-sandbox.mjs](../../bin/joy-mcp-sandbox.mjs)) where possible; keep
   execution isolated (no ambient credentials, validated inputs).
4. **`runtime_invoke` upgrade** — switch the LR5 `runtime_invoke` tool from
   MCP-server-hosted to local IPLD execution. Return the produced output.

---

## Manual verification

1. Purchase an asset whose card has a `skillCID` and license `runtimeExecution:
   true`.
2. `runtime_invoke` fetches the skill, passes the license + PoU gate, executes
   locally, and returns output.
3. An asset with `runtimeExecution: false` (or no PoU) is **refused** before
   execution.
4. Execution is sandboxed — no access to ambient secrets; malformed skill bundles
   are rejected, not run.

---

## Decisions

- Execution is **gated by license + PoU**, never on possession of the CID alone.
- Sandbox isolation is mandatory (OWASP: untrusted code execution); validate the
  skill bundle and run with least privilege.

## Notes

- This milestone is chain-agnostic; it can ship on Sepolia and carry to mainnet
  unchanged once LR7 fills the addresses.
