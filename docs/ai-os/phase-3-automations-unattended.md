# Phase 3 — Unified Automations & Unattended Runs

## Goal

Replace JoyCreate's fragmented scheduling (disk-persisted cron + in-memory trigger store + n8n) with one
persistent Automations system: multi-trigger flows, typed nodes, run history with cost, a background service
that keeps running when the window is closed, and parameter-aware permission rules with pause-and-approve.

## Current state

- **`src/ipc/handlers/agent_schedule_handlers.ts`**: in-process 30s-tick scheduler, schedules persisted to disk
  (not DB), single trigger type (recurring).
- **`src/ipc/handlers/agent_stack_handlers.ts`**: `AgentTrigger` / `CreateTriggerRequest` /
  `TriggerConfig` / `TriggerType` types already defined (`src/types/agent_triggers.ts`), but the store
  (`triggerStore = new Map<string, AgentTrigger>()`) is **in-memory only** — lost on restart — with best-effort
  sync to n8n workflows (`buildTriggerWorkflow`).
- **`src/lib/scheduler_service.ts`** + **`src/ipc/handlers/command_center_handlers.ts`**: command center already
  surfaces "upcoming scheduled jobs" from `SchedulerService` — a real read path exists to build on.
- **n8n integration**: `n8n_handlers.ts` provides NL workflow generation and execution but is a separate system
  from agent triggers; automations should be able to call into n8n as one node type, not replace it.
- **No unattended background service**: closing the JoyCreate window stops everything. No Electron `Tray` +
  login-item wiring exists for this purpose today.
- **No run history with cost**: schedule/trigger fires are not persisted as inspectable run records.
- **No permission-rule engine**: nothing enforces "only allow tool X with parameter Y" for unattended execution.

## Tasks

### 1. Persist triggers to the database
1. Add `automations`, `automationTriggers`, `automationRuns`, `automationRunSteps`, and `automationRuleSets`
   tables to `src/db/schema.ts` (or a new `automation_schema.ts`), replacing the in-memory `triggerStore` in
   `agent_stack_handlers.ts`. Run `npm run db:generate` — never hand-write the migration.
2. Migrate `agent_schedule_handlers.ts`'s disk-persisted schedules into the new `automationTriggers` table
   (one-time migration script, not a runtime dependency).

### 2. Trigger types
1. **Cron** — human-readable schedule picker over standard cron expressions (reuse existing
   `agent_schedule_handlers.ts` tick logic, retarget it at the new DB tables).
2. **Manual** — run-now button, no schedule.
3. **App event** — polls a connected app (see [Phase 6](phase-6-connected-apps-spotlight.md)) at a configurable
   interval (1 min–1 day) and fires on match; support the same firing gates as PandaOS: every match / once /
   cooldown(minutes). Track "already seen" IDs per trigger so restarts never replay a backlog.
4. **Webhook** — generate a per-automation URL with an encrypted, device-scoped secret; posted body available
   to nodes as `{{trigger.payload}}` (cap payload size, e.g. 64 KB).
5. An automation can carry up to 5 triggers; any one starts the flow.

### 3. Flow nodes
1. **AI** — a reasoning/generation step (reuse the existing chat completion path, not a new model-calling
   codepath).
2. **App** — an action on a connected app (Phase 6's action layer).
3. **Agent** — delegates to an `agent_builder` agent (reuses Phase 2's model-binding-aware execution path).
4. **Condition** — branches on an expression or an AI judgment of the previous node's output.
5. **Output** — toast, dated file (`YYYY-MM-DD-name.md`), append/replace an existing file, or new chat in a
   project (so the run becomes a continuable conversation).
6. Node config stored as JSON on `automationTriggers`/flow rows, mirroring the existing `workflowJson` pattern
   already used for `agentWorkflows`.

### 4. Three creation paths
1. **Describe** — NL prompt → generated flow, reusing the same generation approach as `n8n:workflow:generate`
   (AI-first with keyword fallback), scoped to automation node types instead of n8n nodes.
2. **Build** — manual visual builder (reuse workflow canvas patterns already in `workflows.tsx` if present).
3. **Schedule** — trigger-first: pick the cron schedule, then fill in the flow.

### 5. Run history & cost
1. Every fire writes an `automationRuns` row (status, started/finished, per-step `automationRunSteps` with
   tool calls attempted and output/error).
2. Track token/credit cost per run using the same per-model cost table introduced in
   [Phase 2](phase-2-model-routing-failover.md).
3. Surface run history in a new Automations page/tab, reusing `command-center.tsx`'s card patterns for the
   summary view.

### 6. Unattended background service
1. Add an Electron `Tray` icon + `app.setLoginItemSettings({ openAtLogin: true })` (default on, toggle in
   Settings → General) so the scheduler/integrations/credentials survive the main window closing.
2. Sleep/wake handling: on wake, each automation's catch-up policy decides behavior — **run once on wake**
   (default) or **skip** (recorded as a missed run, not executed). Automations migrated from the old scheduler
   default to **skip** so upgrading never causes surprise runs; new automations default to **run once**.
3. If the OS keychain can't unlock when a run starts, fail fast with a distinct "credentials locked" run status
   (amber) plus an OS notification, and retry on the next scheduled fire — never run half-authenticated.

### 7. Permission modes & pause-and-approve
1. Each automation carries a permission mode: **Full access** (any tool, no prompts), **Restricted** (limited
   tool set, never asks), or **Rules** (only pre-allowed calls run; anything else pauses for approval).
2. Rules are parameter-aware: one tool name + optional glob/exact matchers per parameter (case-insensitive,
   `*` wildcard). All matchers on a rule must match; any matching rule in the list allows the call. Read-only
   tools (Read/Grep/Glob-equivalents) are always allowed as a baseline.
3. Rule sets are reusable bundles manageable independently and attachable to multiple automations.
4. On a rules-mode run hitting an uncovered call: pause the run, send an OS notification, show an approval card
   with the full tool + arguments. Options: Deny (agent adapts and continues), Approve once, or Approve &
   always allow (saves a new rule, editable per-parameter before saving, e.g. generalizing to `*@domain.com`).
5. Unanswered approvals time out (default 24h, configurable) and apply a fallback: deny & continue (default) or
   fail the run.
6. A run paused for approval does not survive an app/service restart — it fails with a clear
   "interrupted while paused for approval" status and retries on its next schedule.

## Verification checklist

- [ ] Creating a cron automation persists it to the DB (survives app restart) and appears in run history after
      its first fire.
- [ ] An app-event trigger with `cooldown` gate does not re-fire within the cooldown window even if the
      underlying event repeats.
- [ ] A webhook trigger's URL accepts a POST and the flow receives `{{trigger.payload}}`.
- [ ] Describe-path automation creation produces a runnable flow from a plain-language prompt.
- [ ] Closing the JoyCreate window does not stop a cron automation from firing (verify via tray + run history
      timestamp after window is closed).
- [ ] Putting the machine to sleep through a scheduled fire and waking it triggers exactly one run (default
      catch-up policy), not a backlog.
- [ ] A Rules-mode automation pauses on an uncovered tool call, shows the approval card, and "Approve &
      always allow" persists a working rule for future runs.
- [ ] Locking the OS keychain before a run starts produces an amber "credentials locked" status, not a raw
      per-tool auth error.

## Exit criteria

One Automations surface (not three disconnected systems) with persistent triggers, typed flow nodes, run
history with cost, a background service that survives window close, and enforceable per-run permission rules.
