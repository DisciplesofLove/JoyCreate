# Phase 8 — Projects Parity: Worktrees, Monorepo Root, GitHub Clone, Command Palette

## Goal

Close the remaining project-management gaps: git worktrees for parallel branches, an explicit monorepo app-root
setting, a GitHub device-flow clone dialog, Python virtual environment detection, and a global command palette.

## Current state

- No git worktree support exists — switching branches means stashing or juggling one checkout.
- No explicit "app root" concept for monorepos where the deployable unit is a subfolder of a larger repo.
- No GitHub device-flow clone dialog — projects are added by pointing at an existing local folder.
- No Python virtual environment auto-detection/activation.
- `src/components/ui/command.tsx` already wraps `cmdk` (the same library PandaOS-style command palettes use)
  but nothing surfaces it as a global Cmd+K palette — it's currently only used inside specific components
  (e.g., the decentralized-chat `CommandPalette`).

## Tasks

### 1. Git worktrees
1. Add a "Work on this in a worktree" action (project context menu + chat run-target pill on a new, empty chat)
   that creates a git worktree in its own folder via `git worktree add`, registers it as a linked JoyCreate
   project, and switches the user to it.
2. Hydration: a fresh worktree lacks gitignored files the project needs (`.env`, credentials, local config).
   Before first use, copy the specific gitignored files the project setup command depends on from the parent
   checkout — ask for consent before the first copy, and ask again if the list of files-to-copy changes later
   (never silently apply a changed list).
3. Optionally run the project's existing setup command in the new worktree after hydration.
4. Git panel gets a "Worktrees" tab listing every branch checked out beside the main one.
5. The run-target pill only appears on a brand-new, empty chat; once a chat has a message, a branch
   icon in the sidebar/header shows where it's running instead.

### 2. Monorepo app root
1. Add an `appRoot` field to the project config (relative path, e.g. `apps/frontend/`). Dev servers and file
   operations use this subfolder as the working directory, while Git history and cross-package references still
   see the whole repository.
2. Surface this as a field in project setup/settings, defaulting to the repo root when unset.

### 3. GitHub device-flow clone
1. Add a "Clone from GitHub" path from the New Project flow and the command palette (see below).
2. Implement GitHub Device Flow: request a device code, copy it to clipboard automatically, open the GitHub
   verification page, poll in the background for authorization completion — persist the resulting token
   (respecting existing credential-storage conventions in the app, e.g. OS keychain if already used elsewhere).
3. After authentication, show an autocomplete over the user's repos (name, description, language, private flag,
   up to ~20 results); Enter selects, or a full URL can be pasted directly to skip auth for public repos.
4. Auto-fill the clone destination path from the repo name; allow browsing to a different folder.
5. On completion: clone to disk, auto-add as a JoyCreate project, open the existing project-setup dialog for
   dev-server configuration, toast confirmation.
6. Provide a "Disconnect" action that removes the stored token.

### 4. Python environment detection
1. Detect `venv`/`.venv`/`poetry`/`conda` environments in a project root (or its `appRoot`) and offer to
   auto-activate them for every command JoyCreate runs in that project (terminal, dev server, setup scripts).

### 5. Global command palette
1. Wire `src/components/ui/command.tsx` into a global Cmd+K (Ctrl+K on Windows) shortcut, reachable from
   anywhere in the app, listing: commands (New Project, Clone Repository, New Chat, New Automation, etc.),
   projects (fuzzy-searchable), and connected apps.
2. Keep this centralized rather than duplicating the existing local `CommandPalette` in
   `src/components/decentralized-chat/BotComponents.tsx`, which is scoped to that feature and should remain
   as-is.

## Verification checklist

- [ ] Starting a new empty chat shows a run-target pill offering "This folder" or a new worktree; picking a
      worktree creates it and switches the chat to run there.
- [ ] A newly created worktree has its required gitignored files present (matching what the parent checkout
      has) after the one-time consent prompt.
- [ ] Setting `appRoot` to a subfolder in a monorepo runs the dev server from that subfolder while Git panel
      history still reflects the whole repository.
- [ ] GitHub device-flow clone completes end-to-end: device code shown/copied, verification page opens, app
      detects authorization, repo autocomplete works, clone succeeds, project auto-added.
- [ ] A project with a `.venv` folder automatically runs terminal/dev-server commands inside that environment.
- [ ] Cmd+K opens a global palette from any page and can start a new chat, open a project, or launch the GitHub
      clone dialog.

## Exit criteria

Worktrees, monorepo app-root, GitHub device-flow clone, Python env detection, and a global command palette are
all functional, without disturbing the existing local command-palette usage in decentralized-chat.
