# Phase 9 — Pluggable External Harnesses (Deferred)

> **Status: deferred.** This phase is documented now so the abstraction boundary is known and future phases
> (1–8) don't accidentally hard-code assumptions that would block it later. Do not implement until explicitly
> prioritized.

## Goal

Let JoyCreate run external coding-agent runtimes (Claude Code, OpenAI Codex, OpenCode) as swappable "harnesses"
underneath its own chat/skills/permissions/apps layer — the way PandaOS treats its harness as a replaceable
engine while keeping connected apps, skills, rules, and permissions constant across engines.

## Why deferred

JoyCreate's own agent loop (`chat_stream_handlers.ts` + provider adapters) already does what a harness does —
turning model output into real file edits, terminal commands, and tool calls — for JoyCreate's own use cases
(app building, agent building, marketplace publishing). Adding external harnesses is valuable for pure
coding-assistant workflows but is a large abstraction investment that should follow, not precede, chat UX,
automations, canvas, design, apps, and Atlas parity (Phases 1–8).

## What "harness" means here (for future reference)

A harness is the runtime engine between a model and real actions: it turns model text into file edits, shell
commands, and tool calls. PandaOS's insight worth preserving: the harness is replaceable, but *connected apps*,
*skills*, *project configuration*, and *permissions/sandbox* are a layer above it that stays constant no matter
which harness is active.

## Preparatory constraints for Phases 1–8 (so this stays buildable later)

1. Keep the model-invocation path in `chat_stream_handlers.ts` behind a single internal interface (something
   like `AgentRuntime.streamTurn(...)`), even though today it only has one implementation. Don't scatter
   provider-specific streaming logic across multiple files in a way that would need to be re-abstracted later.
2. Keep skills (Phase 1), permission rules (Phase 3), and connected-app actions (Phase 6) defined independently
   of any specific model-calling code path, so they could in principle be handed to an external harness process
   instead of JoyCreate's own loop.
3. Keep the "which engine is this chat on" concept per-chat (not global) when Phase 1's plan-mode/chat-mode
   work lands, mirroring PandaOS's "each chat remembers its engine" behavior — this avoids a breaking schema
   change later.

## Future task sketch (not to be started now)

1. Define a harness adapter interface: given a project root, a message, and the current permission/tool
   surface, return a stream of actions (file edit, command, tool call) plus a final text response.
2. Implement adapters for Claude Code CLI, OpenAI Codex CLI, and OpenCode, each shelling out to the respective
   CLI/SDK and translating its action stream into JoyCreate's existing tool-call-card rendering.
3. Layer JoyCreate's connected apps (Phase 6), skills (Phase 1), and permission rules (Phase 3) on top of
   whichever harness is active, so switching harnesses mid-conversation doesn't lose apps/skills/rules/project
   setup — only the underlying engine changes.
4. Per-chat harness selection UI, with instant switching and conversation carry-over (no re-send of history).

## Exit criteria (when this phase is eventually prioritized)

Switching a chat between JoyCreate's native engine and an external harness (Claude Code/Codex/OpenCode) is
instant, preserves all apps/skills/rules/project configuration, and requires no separate re-authentication
per harness beyond the harness's own CLI login.
