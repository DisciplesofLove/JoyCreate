# Phase 4 — Canvas: Spatial Multi-Card Workspace

## Goal

Add a board where chats, apps, terminals, browsers, files, and notes sit side by side as independent cards, so
comparing approaches or monitoring several things at once doesn't require juggling tabs.

## Current state

- JoyCreate's `chat.tsx` already uses `react-resizable-panels` for a two-panel (chat + preview) layout — a
  useful building block, but it is a fixed split, not an arbitrary multi-card board.
- No canvas/board route exists. No card-based layout persistence table exists.
- Reusable pieces already exist and should be embedded as-is rather than rebuilt: `ChatPanel`
  (`src/components/ChatPanel.tsx`), `PreviewPanel` (`src/components/preview_panel/PreviewPanel.tsx`), and
  whatever terminal/file-explorer components back the existing dev-server preview flow.

## Tasks

### 1. Data model
1. Add `canvasBoards` (id, name, appId/projectId scope) and `canvasCards` (id, boardId, viewId, type, position
   `{x,y,w,h}`, zIndex, contentRef JSON) and `canvasViews` (named layouts within a board) tables —
   `npm run db:generate`.

### 2. Card types (each renders existing components, does not reimplement them)
1. **Chat** — embeds `ChatPanel`; supports opening a new or existing chat; multiple chat cards run in parallel.
2. **App** — embeds a connected app's workspace tab (depends on [Phase 6](phase-6-connected-apps-spotlight.md)).
3. **Browser** — three modes: standalone URL, project dev-server preview (`PreviewPanel`), or an
   agent-controlled browser tied to a chat card on the same board.
4. **Terminal** — embeds the existing integrated terminal component.
5. **File Explorer** / **File Viewer** — embeds existing file browsing/viewing components.
6. **Plan** — renders the `PlanCard` from [Phase 1](phase-1-chat-ux-parity.md) so a plan stays visible next to
   the chat executing it.
7. **Review** — code-review view for current changes (git diff UI, reuse existing diff rendering if present).
8. **Credentials** — project env vars/secrets view.
9. **Note / Text / Frame / Image** — simple annotation cards; Frame groups other cards and moves them together.

### 3. Layout modes
1. **Freeform** — infinite pannable/zoomable board, drag-to-position, resize via handles, grid-snap.
2. **Grid** — predefined tiled arrangements (single, two columns, two rows, 2×2, three columns); panels resize
   by dragging borders; each panel can hold a card as a tab.
3. **Named views** — a board holds multiple views, each with its own layout + card set; switch via a tab bar;
   create/rename/duplicate/delete views; each view's layout persists independently.

### 4. Card interactions
1. Resize (drag handles), Scale (zoom card content 30–100% independent of board zoom), Duplicate, Detach (pop
   into its own OS window — reuse Electron `BrowserWindow` patterns already used elsewhere in the app for
   detached windows, if any exist; otherwise a new lightweight detached-window IPC path), Connect (draw an edge
   between two cards to visualize a relationship, purely visual/no functional coupling), Undo/Redo (last 30
   board operations).

### 5. IPC & routes
1. New route `/canvas` (TanStack Router) plus IPC channels for board/card CRUD (`canvas:list-boards`,
   `canvas:create-board`, `canvas:save-view`, etc.) — each gets the full handler + `ipc_host.ts` + `preload.ts`
   + `ipc_client.ts` treatment.
2. Reads via `useQuery` (board/card state), writes via `useMutation` (position/size updates debounced to avoid
   flooding the DB on drag).

## Verification checklist

- [ ] Adding a Chat card and an App card to the same board runs both independently without one blocking the
      other.
- [ ] Switching between Freeform and Grid layout modes preserves which cards are present (layout changes,
      content doesn't disappear).
- [ ] Creating a second named view, adding different cards to it, and switching back to the first view restores
      its exact prior layout.
- [ ] Detaching a card opens it in its own window; closing that window does not lose the card's state.
- [ ] Undo restores a card's previous position/size after an accidental drag.

## Exit criteria

A working `/canvas` route with persistent multi-view boards, all documented card types functional (embedding
real existing components, not placeholders), and full IPC registration for board/card persistence.
