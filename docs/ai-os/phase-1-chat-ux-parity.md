# Phase 1 — Chat UX Parity (Plan Mode, Mentions, Skills, Steering, Search)

## Goal

Bring the chat composer and conversation thread up to PandaOS parity: a plan-first interaction mode with
review/revise, @mention-able agents with subagent result cards, slash-invocable skills, message queueing and
steering, context/turn visibility, and full-text chat history search.

## Current state

- **Chat modes**: `ChatModeSchema` (`src/lib/schemas.ts`) already defines `build` / `agent` / `local-agent`.
  There is no `plan` mode.
- **Proposals**: [src/ipc/handlers/proposal_handlers.ts](../../src/ipc/handlers/proposal_handlers.ts) already
  implements an approve/reject action-proposal flow (`chat:process-proposal`, `chat:approve-proposal`) including
  a context-usage-triggered `summarize-in-new-chat` suggestion. This is the right foundation for plan cards —
  it is not currently used for a "review the whole plan before any action runs" mode.
- **Token/context data**: [src/ipc/handlers/token_count_handlers.ts](../../src/ipc/handlers/token_count_handlers.ts)
  (`chat:count-tokens`) already returns `estimatedTotalTokens`, `contextWindow`, and a breakdown
  (message history / codebase / mentioned apps / system prompt). No UI consumes this as a donut/ring.
- **Turn cost data**: assistant messages already carry `maxTokensUsed` (see `token_count_handlers.ts` reading
  `lastAssistantMessage.maxTokensUsed`). No per-turn cost/duration is surfaced in the UI.
- **Skills**: [src/pages/skills.tsx](../../src/pages/skills.tsx) plus `ipc.listSkills` / `createSkill` /
  `executeSkill` / `generateSkill` / `exportSkill` / `bootstrapSkills` give full CRUD + NL generation + execution,
  but skills only run from the Skill Center page — not from `/` in the chat composer, and there's no
  auto-match-by-description.
- **App mentions**: [src/shared/parse_mention_apps.ts](../../src/shared/parse_mention_apps.ts) +
  `extractMentionedAppsCodebases` already implement `@`-mentioning *apps* for codebase context. There is no
  equivalent for *agents*.
- **Agents**: [src/ipc/handlers/agent_builder_handlers.ts](../../src/ipc/handlers/agent_builder_handlers.ts) and
  `agentBuilderClient` fully support agent CRUD, but agents are invoked from `/agents`, never from an @mention
  inside an ordinary chat, and there is no "subagent card" rendering in the chat thread.
- **Chat history**: `src/hooks/useChats.ts` lists chats but there is no full-text search across message content.

## Tasks

### 1. Plan mode
1. Add `"plan"` to `ChatModeSchema` in `src/lib/schemas.ts`.
2. In `src/ipc/handlers/chat_stream_handlers.ts`, when `chatMode === "plan"`, force the model to produce a
   structured plan (title, description, ordered steps, files touched) instead of taking any file/terminal
   action — reuse the existing system-prompt construction path (`constructSystemPrompt`) with a
   plan-only instruction block, mirroring how `build` mode is already special-cased there.
3. Add a `PlanCard` component (renderer) with **Approve / Reject / Revise** actions, modeled on the existing
   proposal-card pattern in `proposal_handlers.ts`. Approve re-sends the plan back to the model with
   "execute this approved plan" and switches the turn to `build`/`agent` mode for that one turn. Reject clears
   the plan and optionally asks for a reason (sent back as the next user message). Revise sends feedback and
   regenerates the plan (new version, not a new chat).
4. New IPC channel `chat:plan-respond` — handler + `ipc_host.ts` registration + `preload.ts` allowlist entry +
   `ipc_client.ts` method (`approve | reject | revise`, with optional `reason`/`feedback`).

### 2. @mention agents + subagent cards
1. Extend `src/shared/parse_mention_apps.ts` (or add a sibling `parse_mention_agents.ts`) to recognize
   `@agent-name` tokens against the existing agents table (`agentBuilderClient.listAgents`).
2. When an agent mention is present, `chat_stream_handlers.ts` delegates that turn to the agent's configured
   instructions/skills (reuse `agent_builder_system_handlers.ts` execution path) instead of the default system
   prompt.
3. Add a `SubagentCard` component: shows agent name/badge, running timer, tool-use count, expandable full
   activity log — reuse the existing tool-call-card rendering already used for the main chat thread.
4. Support @mentioning multiple agents across a conversation (different agents at different turns), each
   producing its own card.

### 3. Slash-command skills in chat
1. Add a `/` trigger in the chat composer that queries `ipc.listSkills()` and renders a filtered command menu
   (reuse `src/components/ui/command.tsx`, the cmdk wrapper that already exists but is unused globally).
2. Selecting a skill inserts/executes it via the existing `ipc.executeSkill({ skillId, input })` call.
3. Auto-match: before sending a normal message, check if its text closely matches an enabled skill's
   description (simple keyword/embedding similarity against the `skills` table) and offer to run that skill
   instead, mirroring PandaOS's "recognizes the match and runs the skill automatically" behavior. Make this
   opt-out per skill (`disableAutoInvocation` boolean column — `npm run db:generate`).

### 4. Context donut, turn stats, queueing & steering
1. Add a small ring/donut in the composer fed by `chat:count-tokens` (`estimatedTotalTokens / contextWindow`).
   Reuse the existing 80%-threshold logic from `proposal_handlers.ts` to color it amber/red.
2. Add an optional "Turn Stats" line below each assistant response (Settings-gated), showing cost estimate,
   duration, and `maxTokensUsed` — cost requires a per-model $/token table (add to
   `src/config/` alongside existing model config, not invented per-call).
3. Queueing: typing while a response streams should queue the message (append to a local pending-queue atom)
   instead of blocking the input; queued messages show above the composer, reorderable/removable, sent in
   order once the turn ends.
4. Steering: a modifier-send (Cmd/Ctrl+Enter) injects the message into the *current* run instead of queuing —
   requires the streaming handler in `chat_stream_handlers.ts` to accept a "steer" message mid-stream via the
   existing stream/IPC channel used for `chat:stream`.

### 5. Chat history search
1. Add a SQLite FTS5 virtual table over `messages.content` (`npm run db:generate` — do not hand-write the
   migration).
2. New IPC channel `chat:search-history` (handler + `ipc_host.ts` + `preload.ts` + `ipc_client.ts`) — query by
   title, project/app, or message content.
3. Wire a search box into the chat sidebar, reusing `useChats.ts` query patterns (new `useQuery` with a debounced
   search term as part of the `queryKey`).

## Verification checklist

- [ ] Selecting Plan mode and sending a message produces a `PlanCard` with zero file/terminal actions taken.
- [ ] Reject discards the plan; Revise regenerates it in place; Approve executes and produces normal tool-call
      cards.
- [ ] Typing `@` in the composer lists agents; selecting one and sending produces a `SubagentCard` with its own
      activity, separate from the main assistant message.
- [ ] Typing `/` lists enabled skills; selecting one runs `executeSkill` and shows output inline.
- [ ] Asking a question that matches an enabled skill's description (without `/`) offers to run that skill.
- [ ] The context donut updates as message history grows and turns amber past ~80% per existing threshold.
- [ ] Typing a new message while a response is streaming queues it; Cmd/Ctrl+Enter steers it into the active run.
- [ ] Chat sidebar search returns matches by title and by message content.

## Exit criteria

Plan mode, @mention agents, slash skills, queueing/steering, context donut, and chat search are all usable from
the default chat page without navigating to a separate settings page, and every new IPC channel is registered
end-to-end (handler + host + preload + client) per repo convention.
