# Phase 6 — Connected Apps: Actions + Embedded Workspace Tabs + Spotlight

## Goal

Turn JoyCreate's existing API-level integrations (GitHub, Supabase, Vercel, n8n, etc.) into full "apps": each
with an action layer the AI can call *and* a live, embedded workspace tab the user can watch and use directly —
tied together by Spotlight, which auto-opens the relevant tab when the AI acts on it.

## Current state

- JoyCreate already has real integrations at the **action** layer: GitHub, Vercel, Supabase, Neon, n8n, plus
  OpenClaw's multi-channel bridge (WhatsApp/Telegram/Slack/Discord/Signal/iMessage — broader than PandaOS's
  single-service model). These are called from chat/automations but have **no embedded workspace UI** — you
  can't see a live Gmail-style inbox or Supabase table browser inside JoyCreate today.
- No Spotlight concept exists — no mechanism auto-opens a UI tab when the AI uses a connected service.
- No per-tool permission model scoped to an individual app exists beyond whatever consent exists for MCP tools
  (`mcp_consent.ts`) — that pattern is worth reusing for app-level tool permissions.

## Tasks

### 1. App framework
1. Define an `AppDefinition` interface: `{ id, name, actions: ActionDefinition[], workspaceTab?: ReactComponent,
   authMethod, spotlightEnabled }`. Each existing integration (GitHub, Supabase, Vercel, n8n) becomes one
   `AppDefinition` registered in a central registry (`src/lib/apps_registry.ts`), rather than scattered ad hoc
   handler files.
2. Actions layer: wrap each integration's existing IPC calls (already implemented) as `ActionDefinition` tool
   entries the chat/automation node system (Phase 3) can invoke uniformly.

### 2. Embedded workspace tabs
1. For services with a web UI (Supabase, GitHub, Notion, Slack, Google Workspace apps), embed via Electron
   `BrowserView`/`webview` with a dedicated session partition per app, OR build a lightweight native React tab
   for services JoyCreate already has structured data for (e.g., a Supabase table/row browser using the
   existing Supabase client rather than embedding Supabase's own dashboard).
2. Each workspace tab lives in the existing dock/tab UI pattern already used for the preview panel.
3. Start with the integrations JoyCreate already has credentials/API access for: GitHub, Supabase, Vercel, n8n —
   do not add brand-new third-party OAuth integrations (Gmail, Slack, Notion, etc.) in this phase; that is a
   separate follow-on once the app framework lands.

### 3. Spotlight
1. Global setting (Settings → General) plus a per-app toggle: when the AI performs an action on an app with
   Spotlight enabled, automatically open/focus that app's workspace tab.
2. Turning Spotlight off for an app stops the tab from auto-following but does not block the AI from using the
   app, and does not prevent explicit "open X" requests from opening the tab.
3. Tools-menu toggle (chat bar) mirrors PandaOS: lets a single conversation turn Spotlight following on/off
   without going into Settings.

### 4. Per-tool permissions
1. Reuse the `mcp_consent.ts` consent-tracking pattern for app-level actions: first use of a sensitive action
   (e.g., a destructive GitHub operation) prompts for consent, remembered per app+action.
2. Feed this into the Phase 3 permission-rules engine so unattended automations respect the same per-app
   consent model.

### 5. App-event triggers
1. Each `AppDefinition` optionally exposes pollable events (new commit, new PR, deployment finished, new/changed
   rows) consumed directly by Phase 3's app-event trigger type — do not build a second polling mechanism.

## Verification checklist

- [ ] GitHub, Supabase, Vercel, and n8n are each registered as an `AppDefinition` with actions callable from
      chat and a visible workspace tab.
- [ ] Asking the AI to "check the latest deployment" opens the Vercel tab automatically (Spotlight on) and shows
      the same deployment the AI is reporting on.
- [ ] Turning Spotlight off for one app stops auto-opening for that app only; other apps still follow.
- [ ] A destructive GitHub action (e.g., deleting a branch) prompts for consent the first time and is
      remembered afterward.
- [ ] An app-event trigger (e.g., "new PR opened") built in Phase 3's automation system fires correctly using
      this app's event source.

## Exit criteria

At least four existing integrations are upgraded to full apps (actions + embedded tab), Spotlight works
end-to-end, and app-level permissions feed the Phase 3 automation permission engine — no new third-party OAuth
integrations added yet.
