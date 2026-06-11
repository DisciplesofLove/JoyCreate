# LR5 — MCP Runtime + Licensing Tool Surface

**Status:** ✅ Done (as-built) — `blueprint_get` served by existing `discover`
**Closes:** G5 (MCP missing the full flow's tools)
**Depends on:** LR1–LR4 (identity, license, PoU/feedback, mandate all exist).

---

## As-built (implemented)

All new tools added to
[web4_marketplace_tools.ts](../../src/mcp_server/tools/web4_marketplace_tools.ts)
as thin wrappers (business logic stays in the main process / shared libs):

- `agent_authorize` (LR4) → `glue:create-mandate` (+ optional `glue:set-store-agent`
  when `storeId`+`agentId` supplied). Returns the mandate + setAgent tx.
- `reputation_submit` (LR3) → `erc8004:submit-feedback` (`clientId`, `serverId`,
  score 0–100, optional `feedbackUri`).
- `license_check` (LR2) → imports the pure `checkLicense`/`normalizeLicense`
  predicate; accepts a terms object **or** an SPDX string + a use
  (`commercial`/`derivative`/`runtimeExecution`); enforces expiry.
- `runtime_invoke` (LR5) → gates on `checkLicense(..., "runtimeExecution")` then
  resolves the agent's `runtime` node from `broker:agent-blueprint`. Returns the
  runtime manifest pointer with `executionMode: "manifest-only (LR5; hosted/local
  execution lands in LR8)"`. Errors if the agent exposes no runtime manifest.
- `purchase_execute` (LR4) — gained an optional `mandateId`: routes to
  `x402:purchase-edition-with-mandate` when present, else `x402:purchase-edition`.
- **`blueprint_get`** — not added separately; the existing `discover` tool already
  returns the ERC-1144 blueprint (identity + runtime + license + reputation) for a
  drop/store/agent. Documented in the tool-file header.

Tests: [src/__tests__/web4_marketplace_tools.test.ts](../../src/__tests__/web4_marketplace_tools.test.ts)
(10 — tool surface, license_check allow/deny, runtime_invoke gate/manifest/no-manifest,
purchase mandate routing, agent_authorize). No new IPC channels were needed (every
tool wraps an already-registered handler or a pure lib).

---

## Goal

Expose the **entire Licensed Runtime Asset flow** as MCP tools so an external
agent (e.g. Claude Desktop) can run, end-to-end:

> register → authorize → drop → purchase → license_check → runtime_invoke

The MCP server already exists ([src/mcp_server/index.ts](../../src/mcp_server/index.ts),
port 3777, `discover` / `purchase_execute` / `drop_launch`). This milestone adds
the missing tools.

---

## Tools to add — [src/mcp_server/tools/web4_marketplace_tools.ts](../../src/mcp_server/tools/web4_marketplace_tools.ts)

- `store_register` — register a store; internally runs LR1 `ensureStoreIdentity`
  + `registerStore` (mints identity + agent card, returns storeId + agentId +
  card CID).
- `agent_authorize` — create an AgentMandate (LR4) and/or `setStoreAgent`;
  returns the mandate + bound agent.
- `reputation_submit` — submit feedback for a settled purchase (LR3).
- `blueprint_get` — return the ERC-1144 blueprint for a store/drop/agent
  (includes `runtime` (LR1) + `license` (LR2) + `reputation` nodes).
- `license_check` — given a drop + requested use, return allow/deny from the LR2
  `checkLicense` predicate.
- `runtime_invoke` — invoke the asset's runtime (LR5: MCP-server-hosted execution;
  LR8: local IPLD execution). Gated by license `runtimeExecution` + PoU.

Existing `purchase_execute` → `x402:purchase-edition` stays; it gains an optional
mandate context (LR4) and emits the LR3 feedback loop.

---

## Work

1. Implement each tool as a thin wrapper over the existing IPC handlers / libs
   (do **not** duplicate business logic in the MCP layer).
2. Where a tool needs a new main-process capability, add the IPC channel via the
   4-edit checklist (handler + ipc_host + preload + ipc_client; throw on error).
3. Register the new tools in the server's tool list; keep input schemas tight
   (zod) and return structured JSON.
4. Document the tool contract (args/returns) in the tool file header.

---

## Manual verification (end-to-end, Arbitrum Sepolia)

From an MCP client with the JoyCreate server connected, run the full sequence and
confirm each step's on-chain effect:

1. `store_register` → `AgentRegistered` + `StoreRegistered`.
2. `agent_authorize` → mandate created (+ optional `setAgent`).
3. `drop_launch` → `DropCreated`.
4. `purchase_execute` → x402 settlement + (LR3) `grantProof` + feedback.
5. `license_check` → correct allow/deny for the requested use.
6. `runtime_invoke` → produces output (hosted execution; local in LR8).

---

## Decisions

- MCP tools are **thin wrappers** over existing handlers/libs — single source of
  truth stays in the main process.
- Runtime execution in LR5 is **MCP-server-hosted**; local IPLD execution is LR8.

## Notes for next milestone

- LR6 adds discovery (subgraph) so `discover` / `blueprint_get` can resolve from
  an index instead of slow RPC reads.
