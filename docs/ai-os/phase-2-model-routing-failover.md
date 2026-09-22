# Phase 2 — Model Routing, Auto-Selection & Failover

## Goal

Let JoyCreate pick the right model automatically, fail over across providers when one hits a usage limit, show
session usage the way PandaOS does, and let agents carry their own model binding independent of the active chat.

## Current state

- **Providers**: JoyCreate already supports BYOK (multiple providers) plus local Ollama/LM Studio via
  `UnifiedModelPicker` / `ProviderCarousel`. Users manually pick a model per chat.
- **Reasoning effort**: per repo memory ([reasoning-effort-temperature.md](../../.github/instructions/ipc-handlers.instructions.md)
  — see `/memories/repo/reasoning-effort-temperature.md`), reasoning-effort/temperature plumbing partially
  exists already; confirm current coverage before extending.
- **No auto-routing**: the user always chooses the model explicitly; there's no task-classifier that picks a
  lightweight vs. capable model automatically.
- **No failover**: if a provider connection hits a rate limit or usage cap, the chat simply errors — there is no
  ordered fallback list of connections to retry against.
- **No session usage ring**: no UI shows rolling-window usage against a plan/quota.
- **Agents**: `agent_builder_handlers.ts` stores agent config but has no model-binding field (inherit / tier /
  pinned model) or reasoning-effort override.

## Tasks

### 1. Auto-routing
1. Add an `autoRouting` boolean to user settings (`readSettings`/`writeSettings` in `@/main/settings`).
2. Add a lightweight task classifier (heuristic first: message length, presence of code blocks/file paths,
   chat mode) that maps to a "Low / Medium / High" tier, each tier resolving to a configured model per the
   active connection's catalogue.
3. When auto-routing is on, `chat_stream_handlers.ts` resolves the model from the tier instead of the
   explicitly-selected model, and the composer shows which model was auto-selected for transparency.

### 2. Usage-limit failover
1. Add a per-user ordered list of connections (`Settings → Connections → Failover order`), persisted via
   `writeSettings`.
2. Detect provider usage-limit errors in the streaming handler (`chat_stream_handlers.ts`) by classifying
   known rate-limit/quota error shapes per provider adapter.
3. On a usage-limit error, if failover is enabled, retry the same turn against the next connection in the list
   before surfacing an error to the user. Log which connection actually served the response (needed for cost
   tracking).
4. New IPC channel `settings:get-failover-order` / `settings:set-failover-order` (handler + `ipc_host.ts` +
   `preload.ts` + `ipc_client.ts`).

### 3. Session usage ring
1. For providers that expose usage/limit data (Anthropic Claude subscription headers, OpenAI Codex), surface a
   ring next to the context donut (Phase 1) showing rolling-window usage, colored amber >70%, red >90%.
2. New IPC channel `usage:get-session-limits` polling the active provider's usage endpoint, cached briefly to
   avoid hammering the API.
3. Click-to-expand popover listing every limit on the plan (session, weekly, per-model weekly), each with a
   countdown and reset time — mirrors the breakdown table already described for PandaOS.
4. For connections with no usage API (BYOK raw keys, local models), simply don't show a ring — do not fabricate
   data.

### 4. Per-agent model binding
1. Add `modelBinding` (`{ mode: "inherit" | "tier" | "model"; tier?: "low"|"medium"|"high"; connectionId?: string;
   modelId?: string }`) and `reasoningEffortOverride` columns to the agents schema (`npm run db:generate`).
2. Agent editor UI: a model section with the three modes described in the PandaOS reference — inherit (default),
   tier, or pinned connection+model.
3. When an agent activates (via @mention from Phase 1, or from an automation in Phase 3), the execution path
   switches the harness/model per its binding, then switches back to whatever the chat was using when the agent
   finishes.
4. Add a Tools-menu toggle (per chat, ephemeral) that disables agent-driven model switching entirely — when off,
   every agent runs on whatever the user picked, regardless of its binding.
5. First time an agent auto-switches the model for a chat, show a one-time toast so the user isn't surprised.

## Verification checklist

- [ ] With auto-routing on, a simple message stays on the Low tier model and a complex coding request escalates
      to High — verify via logged model-selection decision.
- [ ] Simulate a usage-limit error from the primary connection; with failover configured, the turn completes
      using the next connection in the list without surfacing an error.
- [ ] Session usage ring appears only for connections that expose usage data (Claude/Codex), and the popover
      shows session + weekly + per-model breakdown.
- [ ] Creating an agent with `tier: high` and invoking it via @mention runs it on the High-tier model even
      while the chat itself is on a Low-tier model, then the chat's next turn reverts to the chat's model.
- [ ] Disabling "agent model switching" in the Tools menu keeps every agent on the chat's model for that session.

## Exit criteria

Auto-routing, failover, session usage visibility, and agent model binding are all functional and configurable
without editing settings files by hand; all new IPC channels follow the 4-step registration checklist.
