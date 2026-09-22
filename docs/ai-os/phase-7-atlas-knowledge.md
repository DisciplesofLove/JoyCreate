# Phase 7 — Atlas-Style Auto-Written Knowledge Base

## Goal

Give JoyCreate a background knowledge writer that distills decisions, problems, and project shape out of a
user's actual work — no manual note-taking — so future chats can be told what was already worked out, the way
PandaOS's Atlas does.

## Current state

- **`src/db/agent_memory_schema.ts`** already provides a memory-storage foundation (schema exists) but nothing
  currently writes passive, cross-session "what we learned" knowledge from ordinary chat activity.
- **`src/prompts/system_prompt.ts`** (`readAiRules`) already injects per-project rules/knowledge files into the
  system prompt — the injection point Atlas-derived knowledge should plug into, not a new prompt path.
- No background writer process, no "watched projects" picker, no ignore-rules concept, no spend ceiling, and no
  review/curate UI exist today.

## Tasks

### 1. Background writer
1. After a chat session goes idle (or on a periodic tick), a background job summarizes what happened — decisions
   made, problems solved, conventions established — into short knowledge entries scoped to the project.
2. Runs as a low-priority background task (reuse the existing scheduler infra from
   [Phase 3](phase-3-automations-unattended.md) rather than inventing a second background-job runner), so it
   never competes with an in-flight chat turn for model capacity.
3. Add a `knowledgePages` table (projectId, title, content, sourceSessionIds, createdAt, updatedAt) —
   `npm run db:generate`.

### 2. Spend ceiling
1. Add a configurable budget (tokens or credits per day/week) for background knowledge writing in Settings; the
   writer stops producing new pages once the ceiling is hit for the period, resuming next period.

### 3. Watched projects & ignore rules
1. A "Watched projects" picker (Settings → Atlas or a dedicated page) selects which projects Atlas may learn
   from.
2. Per-project ignore rules (glob patterns) carve out files/paths that must never be read for knowledge
   extraction — critical for projects holding credentials, customer data, or vendored dependencies. Default to
   respecting `.gitignore` plus an explicit additional ignore list.

### 4. Review & curate UI
1. A knowledge-map view groups pages by originating project (reuse a card-list layout consistent with existing
   dashboard pages, e.g. `command-center.tsx`'s card patterns).
2. Users can view, edit, and delete any knowledge page — never a black box.
3. Sharing exports the knowledge as files (Markdown), not a hosted link, so handing knowledge to someone never
   publishes it anywhere.

### 5. Injection into chats
1. Extend `readAiRules` (or a sibling function) to also load relevant `knowledgePages` for the active project
   and fold them into the constructed system prompt, the same way existing rules/knowledge files are injected
   today — keep this additive, not a replacement for existing rules-file support.
2. Only inject pages relevant to the current chat's context (simple recency + project-match filter to start;
   avoid dumping the entire knowledge base into every prompt).

## Verification checklist

- [ ] After a multi-turn chat session that makes a clear decision (e.g., "we chose Drizzle over Prisma because
      X"), a knowledge page capturing that decision appears without any manual action.
- [ ] Background writing never delays or blocks an in-flight chat response.
- [ ] Hitting the configured spend ceiling stops new knowledge writes until the next period.
- [ ] Adding a path to a project's ignore rules prevents any content from that path appearing in a generated
      knowledge page.
- [ ] Editing or deleting a knowledge page in the review UI persists and is reflected in the next chat's
      injected context.
- [ ] A new chat on the same project references a previously-recorded decision without the user re-explaining
      it.

## Exit criteria

Atlas-equivalent passive knowledge capture is live, budget-capped, scoped by watched-projects + ignore rules,
fully user-editable, and feeding the existing system-prompt construction path.
