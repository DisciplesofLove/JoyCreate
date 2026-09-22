# LR9 — Phase 2: Tool-Calling Skill Runtime

**Status:** ✅ Done (as-built)
**Track:** A (Agentic Runtime)
**Closes:** LR8's deferred "tool-call execution left declarative" gap.
**Depends on:** LR8 (skill runtime core), `mcp_ai_bridge.buildMcpToolSet`, `get_model_client`.

---

## As-built (implemented)

The LR8 runtime now supports a second skill kind — `tool-agent` — that runs the
AI SDK multi-step agentic loop with an explicit, bundle-declared allow-list of
MCP tools. The single-shot `prompt-agent` path (LR8) is unchanged.

- **Skill bundle union** — [src/lib/onchain/skill_runtime.ts](../../src/lib/onchain/skill_runtime.ts):
  `SkillBundle` is now `PromptAgentBundle | ToolAgentBundle`. A `tool-agent`
  bundle adds `tools: string[]` (fully-qualified MCP names `mcp__<server>__<tool>`)
  and an optional `maxSteps` (default `DEFAULT_TOOL_STEPS = 6`, hard-clamped to
  `MAX_TOOL_STEPS = 12`).
- **Validation** — `parseSkillBundle` accepts both kinds. For `tool-agent` it
  requires a **non-empty** allow-list, validates every name against
  `mcp__<server>__<tool>`, and clamps `maxSteps`. Malformed bundles throw; nothing
  is ever `eval`/`require`d.
- **Injectable tool loop** — a new `ToolAgentFn` dep (alongside `InferenceFn`)
  keeps the MCP hub + model client out of the unit-test graph. The default
  implementation lazily imports `ai`, `buildMcpToolSet`, `getModelClient`, and
  `readSettings`, then runs `generateText` with `maxSteps` and **only** the
  allow-listed tools (`buildMcpToolSet({ allowHeadless: true, toolAllowList })`).
- **Branched execution** — `executeSkill` routes `tool-agent` skills through
  `toolAgent` and `prompt-agent` skills through `infer`. The result now carries
  `kind` and `steps` (1 for prompt-agent, the loop count for tool-agent).
- **`runtime_invoke` surface** —
  [src/mcp_server/tools/web4_marketplace_tools.ts](../../src/mcp_server/tools/web4_marketplace_tools.ts):
  reports `skillKind`, `steps`, and an `executionMode` of
  `"local-ipld tool-agent (LR9)"` vs `"local-ipld prompt-agent (LR8)"`.

**Security posture:** a tool-agent can only reach the tools it allow-lists, and
every call still passes the existing MCP **consent** layer inside
`buildMcpToolSet` (user-denied tools throw; headless callers proceed only when
allowed). The bundle cannot widen its own permissions. License + PoU gating
(LR2/LR3) is unchanged and still runs before any resolution.

**Tests:** [src/__tests__/skill_runtime.test.ts](../../src/__tests__/skill_runtime.test.ts)
grew to 22 (valid tool-agent parse, empty/ malformed allow-list rejection,
`maxSteps` clamp, and a tool-loop execution case proving the prompt-agent
inference path is *not* used). All pass; oxlint clean.

**Deferred:** true end-to-end still needs a loaded local/cloud model and a pinned
tool-agent bundle (LR11 authoring + pinning closes the pinning half).

---

## Goal

Let a purchased Licensed Runtime Asset be a real **agent**, not just a single
prompt: reason over multiple steps and call a constrained set of MCP tools, while
keeping the LR8 license + PoU gate and adding no new RCE surface.

---

## Work

1. Extend `SkillBundle` with `kind: "tool-agent"` (`tools` allow-list + `maxSteps`).
2. Validate the allow-list and step cap in `parseSkillBundle`.
3. Add an injectable `ToolAgentFn`; default it to the AI SDK `generateText` loop
   fed by `buildMcpToolSet({ toolAllowList, allowHeadless })`.
4. Branch `executeSkill` by kind; surface `kind`/`steps` through `runtime_invoke`.

---

## Manual verification

1. Pin a `tool-agent` bundle that allow-lists e.g. `mcp__brave__web_search`; set
   its CID as the agent's `skillCID`.
2. `runtime_invoke` with `input` runs the loop, calls only allow-listed tools, and
   returns `executionMode: "local-ipld tool-agent (LR9)"` with a `steps` count.
3. A tool the bundle did not allow-list is never offered to the model.
4. A user-denied MCP tool still throws inside the loop (consent layer).

---

## Decisions

- Tools are an **explicit allow-list in the bundle**, never "all MCP tools".
- The consent layer is authoritative — a bundle cannot bypass user denials.
- `maxSteps` is hard-clamped (`MAX_TOOL_STEPS`) regardless of bundle value.

## Notes

- Chain-agnostic; ships on Sepolia and carries to mainnet unchanged.
