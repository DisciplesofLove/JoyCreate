# Phase 5 — Design Studio: Versioned Artifacts & Handoff

## Goal

Turn JoyCreate's existing document/design-system pages into a full artifact studio: documents, prototypes,
mockups, slide decks, and motion pieces, all built against a reusable design-system pack, versioned on every
change, and shareable or handed off to a coding session as a developer bundle.

## Current state

- **`src/pages/DesignSystemPage.tsx`**: design-system authoring already exists (palette/type/spacing concepts),
  including an `outputDir` for generated systems — a real foundation for "design-system packs," not a
  greenfield build.
- **`src/pages/document-editor.tsx`**: already has `slides` state (`useState<Slide[] | null>`) — slide-deck
  support is partially built.
- **`src/pages/documents.tsx`**: has a "sales-dashboard" style document template concept already.
- **No unified artifact type system**: document/prototype/mockup/slides/motion are not modeled as one
  versioned entity today; there's no share-link, export-format matrix, or handoff-bundle generation.
- **No design-system pack import**: no code path extracts tokens from a Tailwind config, CSS variables, or
  pasted brand text.

## Tasks

### 1. Data model
1. Add an `artifacts` table (id, projectId, type: `document|prototype|mockup|slides|motion|freeform`, current
   HTML/content, designSystemPackId) and `artifactVersions` (artifactId, version, content, createdAt, source:
   `tweak|comment|chat|edit`) — `npm run db:generate`. Every change creates a new version row, never overwrites.
2. Add `designSystemPacks` (id, scope: `project|personal`, palette/type-scale/spacing/corners/voice JSON,
   sourceType: `codebase|document|manual`).

### 2. Artifact types
1. **Document** — reports/one-pagers/briefs; export PDF + HTML. Build on `documents.tsx`'s existing template
   concept.
2. **Prototype** — clickable multi-screen HTML flow with real navigation state.
3. **Mockup** — single high-fidelity static screen; export HTML + PDF.
4. **Slides** — full deck from a description/notes/brief, built on the existing `Slide[]` state in
   `document-editor.tsx`; export PPTX (and optionally Google Slides via existing Google integration if
   connected).
5. **Motion** — animated intros/product reels on a scrubbable timeline with per-element tracks; export HTML +
   MP4 (requires a headless render pipeline — reuse any existing video/export tooling in the repo before adding
   a new dependency).
6. **Freeform** — arbitrary HTML, no fixed methodology.
7. Explicitly **defer** "Product Demo" (screen-recording-to-MP4 with auto-zoom) — PandaOS itself ships this as
   "coming soon" pending a recording-permission model; do not build it in this phase.

### 3. Design-system packs
1. **Import from codebase**: parse Tailwind config / CSS custom properties out of the current project to
   populate a pack (reuse whatever config-parsing utilities already exist for the project's build tooling).
2. **Import from document**: paste a style guide, brand PDF text, or token dump; extract colors/type/spacing via
   an AI extraction prompt (structured-output call, not regex-only) since PandaOS explicitly reads text loosely
   rather than expecting a fixed format.
3. Packs save to the project or to a personal library reusable across projects; before starting a build, ask the
   user which pack to use rather than silently defaulting.

### 4. Refining an artifact (always produces a new version)
1. **Tweaks** — live controls for color/type/spacing/layout.
2. **Comments** — pin a note to an element with a written instruction; resolved into a targeted edit, not a
   full regeneration.
3. **Chat** — conversational edit requests apply to the specific element, not the whole file.
4. **Layers/inspector** — direct element selection and property editing.
5. A version menu lists full history with the ability to revert to any prior version. Motion artifacts add a
   scrubbable timeline with per-element tracks.

### 5. Share, export, handoff
1. **Share** — publish the current version as a view-only public link, no JoyCreate account required to open
   it. Given JoyCreate's existing decentralized-publish pipeline (IPFS/Arweave/4EVERLAND), prefer that over
   standing up a new hosted-link service — this is a differentiator PandaOS doesn't have (its share links are
   centrally hosted).
2. **Export** — per-type format matrix above (PDF/HTML/PPTX/MP4).
3. **Handoff** — a developer bundle: frozen HTML, resolved design-system tokens, the original brief, and a
   stable id per element, so a coding session builds the real multi-file implementation against a fixed
   reference instead of reverse-engineering a single HTML file.

## Verification checklist

- [ ] Creating any artifact type produces a versioned entity; every tweak/comment/chat/edit adds a new version
      without discarding history.
- [ ] Importing a design-system pack from the current project's Tailwind config populates a usable palette/type
      scale pack.
- [ ] Pasting brand-guide text into the "import from document" path extracts a sensible pack (manual spot-check,
      not exact-format parsing).
- [ ] Share produces a public view-only link openable without signing in.
- [ ] Handoff produces a bundle containing frozen HTML + tokens + brief + stable element ids, consumable by a
      follow-up coding chat.
- [ ] Slides export to a valid PPTX file that opens in PowerPoint/Keynote/Google Slides.

## Exit criteria

Documents, prototypes, mockups, slides, and motion are all buildable as versioned artifacts against a shared
design-system pack, with working share links and a real handoff bundle format — Product Demo explicitly
deferred.
