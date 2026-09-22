# JoyCreate as an AI OS — Gap Analysis & Phase Plan

Benchmark: [PandaOS](https://docs.pandaos.ai/docs) — an "AI-native desktop that works with your real tools." This
folder tracks what JoyCreate needs to build, extend, or reuse to match and then exceed it.

Each `phase-N-*.md` file is self-contained: Goal, Current state (with file references), Tasks (including the
IPC registration checklist from [ipc-handlers.instructions.md](../../.github/instructions/ipc-handlers.instructions.md)),
Verification checklist, Exit criteria. Phases are implementation-ready specs, not just notes — build directly
from them.

## Gap matrix

| PandaOS capability | JoyCreate status | Phase |
|---|---|---|
| Plan mode (propose → review → approve/reject/revise) | Partial — [proposal_handlers.ts](../../src/ipc/handlers/proposal_handlers.ts) has action proposals, no dedicated plan-first chat mode | [Phase 1](phase-1-chat-ux-parity.md) |
| Context window donut + turn stats (cost/duration/tokens) | Backend exists ([token_count_handlers.ts](../../src/ipc/handlers/token_count_handlers.ts)), no composer UI | [Phase 1](phase-1-chat-ux-parity.md) |
| @mention agents in chat, subagent cards | Missing — agents only reachable via /agents page | [Phase 1](phase-1-chat-ux-parity.md) |
| Slash-command skills + auto-match in chat | Partial — full skill CRUD/generate/execute exists ([skills.tsx](../../src/pages/skills.tsx)), not invocable from the composer | [Phase 1](phase-1-chat-ux-parity.md) |
| Message queueing & steering | Missing | [Phase 1](phase-1-chat-ux-parity.md) |
| Chat history full-text search | Missing | [Phase 1](phase-1-chat-ux-parity.md) |
| Auto-routing model selection | Missing | [Phase 2](phase-2-model-routing-failover.md) |
| Usage-limit failover across providers | Missing | [Phase 2](phase-2-model-routing-failover.md) |
| Session usage ring / plan limits popover | Missing | [Phase 2](phase-2-model-routing-failover.md) |
| Per-agent model binding (inherit/tier/pinned) + reasoning-effort override | Missing | [Phase 2](phase-2-model-routing-failover.md) |
| Unified automations (cron/manual/app-event/webhook triggers, flow nodes, run history+cost) | Fragmented — [agent_schedule_handlers.ts](../../src/ipc/handlers/agent_schedule_handlers.ts) (disk-persisted cron) + [agent_stack_handlers.ts](../../src/ipc/handlers/agent_stack_handlers.ts) (in-memory trigger store) + n8n | [Phase 3](phase-3-automations-unattended.md) |
| Unattended background service, permission modes, pause & approve | Missing | [Phase 3](phase-3-automations-unattended.md) |
| Canvas spatial board (multi-card workspace) | Missing | [Phase 4](phase-4-canvas-board.md) |
| Design studio artifacts (docs/slides/mockups/prototypes/motion, design-system packs, handoff bundles) | Partial — [DesignSystemPage.tsx](../../src/pages/DesignSystemPage.tsx), [document-editor.tsx](../../src/pages/document-editor.tsx) | [Phase 5](phase-5-design-studio-artifacts.md) |
| Connected apps with embedded workspace tabs + Spotlight | Partial — API-level integrations only (GitHub/Supabase/Vercel/n8n), no embedded UI | [Phase 6](phase-6-connected-apps-spotlight.md) |
| Atlas-style auto-written knowledge base | Partial foundation — [agent_memory_schema.ts](../../src/db/agent_memory_schema.ts) | [Phase 7](phase-7-atlas-knowledge.md) |
| Git worktrees, monorepo app-root, GitHub device-flow clone, Python env detection, command palette | Missing (cmdk component exists unused globally — [command.tsx](../../src/components/ui/command.tsx)) | [Phase 8](phase-8-projects-parity.md) |
| Pluggable external harnesses (Claude Code / Codex / OpenCode) | Missing — deferred | [Phase 9](phase-9-external-harnesses.md) (deferred) |
| Voice input (STT/TTS) | **JoyCreate already ahead** — [voice_assistant_handlers.ts](../../src/ipc/handlers/voice_assistant_handlers.ts) (Whisper + ElevenLabs) | n/a |
| MCP tool support | **JoyCreate already ahead** — full server/tool/consent lifecycle | n/a |

## Where JoyCreate already exceeds PandaOS

These are not gaps — they're differentiators to preserve and lean into while closing the gaps above:

- **On-chain marketplace + creator economy**: JoyMarketplace publishing, JCN records, rewards ledger, revenue
  splitter contracts — PandaOS has no monetization layer at all.
- **OpenClaw multi-channel gateway**: WhatsApp/Telegram/Slack/Discord/Signal/iMessage bridge with its own Kanban
  and activity system — PandaOS's "apps" are single-service integrations, not a channel-agnostic gateway.
- **Decentralized deployment**: IPFS/Arweave/4EVERLAND publish pipeline, trustless inference, NFT-backed assets.
- **Local model stack**: Ollama/LM Studio bridges, model registry, distillation/flywheel training loop.
- **Voice assistant**: built-in STT/TTS PandaOS does not have at all in its documented feature set.

## Sequencing

Phases are ordered by daily-use impact first (chat UX), then by architectural weight (automations, canvas,
design, apps, atlas, projects). Phase 9 (external harnesses) is explicitly deferred — documented now so the
abstraction boundary is known, implemented later.

## Conventions every phase file follows

- New IPC channels: handler in `src/ipc/handlers/**`, registration in `src/ipc/ipc_host.ts`, allowlist entry in
  `src/preload.ts`, client method in `src/ipc/ipc_client.ts`. Handlers throw on error.
- Schema changes: run `npm run db:generate` — never hand-write migration SQL.
- Reads → `useQuery`; writes → `useMutation` with query invalidation.
- Keep changes scoped to the phase; don't refactor unrelated code.
