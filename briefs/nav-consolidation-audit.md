# Navigation & Feature Consolidation Audit

**Date:** May 3, 2026
**Author:** LoveAssistant
**Status:** Phase 1 ready to ship. Phases 2–4 await Terry's sign-off.
**Owner:** Terry
**Scope rule (Terry, May 3 17:31 EDT):** Do **not** touch
- App Builder Studio (`/app-builder`)
- Local AI / inference (`/local-models`, `/model-download`, `/model-registry` — read only)
- Joy Assistant (`joy_assistant_handlers.ts` and the on-canvas assistant)

Anything else with **>30% functional overlap is a candidate for consolidation**.

---

## TL;DR

The app currently exposes **116 sidebar entries across 11 sections**, **82 routes**, **~120 page files**, and **165 IPC handler files**. By any honest read, this is too many doors for the same rooms. A user looking for "the marketplace" sees five entries. A user looking for "manage agents" sees seven. A user looking for "my profile and identity" sees four.

I found **9 high-confidence consolidation clusters** (>30% overlap, often closer to 80%). Implementing them collapses:

| | Before | After (Phase 1+2) |
|---|---|---|
| Sidebar entries | 116 | **~62** |
| Sections | 11 | **8** |
| Active routes | 82 | **~52** (others kept as redirect/deprecation banner stubs) |
| IPC handler files | 165 | **~140** (further work in Phase 4) |

**Phase 1 (this PR — already proven safe):** Drop the duplicate marketplace + creator-dashboard pages that the recent on-chain marketplace work explicitly replaced. They already render `JoyDeprecationBanner`. Section C of `briefs/droperc1155-read-layer-surgery.md` *designed* this consolidation; we just haven't executed the cleanup half yet.

**Phases 2–4:** Bigger structural moves. Need Terry's sign-off per cluster before I ship.

---

## Methodology

For each candidate I checked:
1. **Same data source?** Do they call the same hook / IPC handler / subgraph?
2. **Same user job?** Does a sane user expect them to be one place?
3. **Self-declared overlap?** Several pages literally have JSDoc comments saying "this replaces X".
4. **Risk to remove?** What still links to it?

Evidence is a path + line range so Terry can verify, not trust me blindly.

---

## CLUSTER 1 — Marketplace (5 → 1)  [PHASE 1 — SHIP NOW]

**Overlap: ~85%.** All five browse the same on-chain DropERC1155 data through `useMarketplaceBrowse`. The Joy pages explicitly say so in their JSDoc.

| Sidebar entry | Route | Page file | Status |
|---|---|---|---|
| Joy Marketplace › Marketplace | `/joy/marketplace` | `pages/joy/MarketplacePage.tsx` | ✅ **KEEP — canonical** |
| Publish › Marketplace | `/nft-marketplace` | `pages/nft-marketplace.tsx` | ❌ Drop nav entry, keep page as banner |
| Publish › Explore Marketplace | `/marketplace` | `pages/marketplace-explorer.tsx` | ❌ Drop nav entry, keep page as banner |
| Publish › On-Chain Market | `/on-chain-marketplace` | (route only, no dedicated page) | ❌ Drop entirely |
| Publish › Plugin Market | `/plugin-marketplace` | `pages/PluginMarketplacePage.tsx` | ⚠️ Move into `/joy/marketplace` as a "Plugins" filter, drop top-level entry |

**Evidence:**
- `pages/joy/MarketplacePage.tsx:7` — JSDoc literally states: *"Replaces (functionally, not literally — D9 keep-old-pages): /marketplace-explorer, /nft-marketplace (browse half)"*
- `pages/marketplace-explorer.tsx` and `pages/nft-marketplace.tsx` already import `JoyDeprecationBanner` — half the work was done in PR #24, the nav cleanup just never landed.

**Phase 1 action:** remove the 4 duplicate sidebar entries; leave deprecation pages reachable by URL for any bookmarked links.

---

## CLUSTER 2 — Creator/Asset Dashboard (4 → 2)  [PHASE 1]

**Overlap: ~70%.**

| Sidebar entry | Route | Status |
|---|---|---|
| Joy Marketplace › My Stores | `/joy/my-stores` | ✅ KEEP — canonical store mgmt |
| Joy Marketplace › My Assets | `/joy/my-assets` | ✅ KEEP — canonical asset list |
| Publish › My Creations | `/creator` (`creator-dashboard.tsx`) | ❌ Drop nav entry, keep page as redirect |
| Publish › My Assets | `/my-marketplace-assets` | ❌ Drop nav entry, page already has deprecation banner |
| Sovereign › Creator Profile | `/creator-profile` | ⚠️ Move under Profile (Cluster 5) |

**Evidence:**
- `pages/joy/MyAssetsPage.tsx:5` — JSDoc: *"Replaces /my-marketplace-assets (which stays as a deprecation banner per D9)"*
- `pages/joy/MyStoresPage.tsx:5` — JSDoc: *"Per the plan, this replaces the store-management bits of /creator-dashboard"*

---

## CLUSTER 3 — Publish/Deploy (5 → 2)  [PHASE 2]

**Overlap: ~60%.** Currently there are FIVE ways to "publish/deploy" something.

| Sidebar entry | Route | Notes |
|---|---|---|
| Joy Marketplace › Publish | `/joy/publish` | ✅ KEEP — Universal Asset Wizard, deep-link target from studios |
| Publish › Publish | `/deploy` | Web2 deploy (Vercel/Supabase/etc.) — KEEP, rename "Web Hosting" |
| Publish › App Publishing | `/app-publishing` | iOS/Android/PWA mobile builds — KEEP, rename "Mobile & PWA Builds" |
| Publish › Web3 Deploy | `/decentralized-deploy` | IPFS/4everland/Fleek — **MERGE into `/deploy` as a tab** |
| Publish › Create Asset | `/create-asset` | Old MarketplaceV3 wizard — **DELETE**, the contract is retired |

**Phase 2 action:** rename the "Publish" sidebar section to "Distribute" (or kill it — see proposed nav below), keep 3 entries: marketplace publish, web hosting, mobile builds. `create-asset.tsx` references `CreateAssetWizard` which (per MEMORY.md May 2 entry) is now a deprecation stub anyway.

---

## CLUSTER 4 — Agent Pages (8 → 3)  [PHASE 2 — needs Terry's call]

**Overlap: ~50%.** Eight agent-management pages with substantial conceptual overlap.

| Sidebar entry | Route | What it does |
|---|---|---|
| AI & Agents › Agents | `/agents` | List & edit agents (the basic CRUD) |
| AI & Agents › Agent Swarm | `/agent-swarm` | Multi-agent self-replicating witness setup |
| AI & Agents › Agent Orchestrator | `/agent-orchestrator` | Voice/text task submission to meta-agent |
| AI & Agents › Automation Orchestrator | `/automation-orchestrator` | "Activate all", n8n triggers, email automation |
| AI & Agents › Autonomous Agent | `/autonomous-agent` | "Perpetually growing AI system" UI |
| AI & Agents › Agent Production | `/autonomous-agent-production` | Production dashboard for autonomous agent |
| AI & Agents › Coding Agent | `/coding-agent` | Code-writing agent UI |
| (orphaned) | (no route) `pages/AgenticOSDashboard.tsx` | "Central command center" for 14 agents |

**Proposal:**
- **`/agents`** → KEEP, becomes the canonical "all agents" surface with tabs: List | Activity | Production | Swarm
- **`/agent-orchestrator`** → KEEP as `/agents/orchestrate` — task submission cockpit (genuinely different UX)
- **`/coding-agent`** → KEEP as a dedicated workspace (specialized enough to justify)
- **DELETE/ABSORB:** `/agent-swarm`, `/automation-orchestrator`, `/autonomous-agent`, `/autonomous-agent-production`, `AgenticOSDashboard`

⚠️ **Need Terry's call:** Agent Swarm, Autonomous Agent, and AgenticOSDashboard each represent *real implemented features* (not dead code) and Terry has spoken passionately about each. Pick which 1–2 stay first-class vs absorbed.

---

## CLUSTER 5 — Identity / Profile (4 → 1)  [PHASE 2]

**Overlap: ~75%.**

| Sidebar entry | Route | Notes |
|---|---|---|
| Sovereign › Universal Identity | `/identity` | DID + ENS/JNS + wallets + reputation — ✅ KEEP as canonical |
| Sovereign › SSI Credentials | `/ssi-credentials` | Verifiable credentials (issue/verify) — **MERGE** as tab inside `/identity` |
| Sovereign › Creator Profile | `/creator-profile` | Public-facing profile page — **MERGE** as tab inside `/identity` (Public View) |
| Admin › Profile | `/profile` (`UserProfilePage`) | Account/billing/connected services — **MERGE** as tab inside `/identity` (Account) |

Result: **`/identity` becomes the single "who am I" page** with tabs: Identity (DID/ENS) | Public Profile | SSI Credentials | Account & Billing | Activity. This is exactly what users expect — one place for "me".

---

## CLUSTER 6 — Memory / Learning (3 → 1)  [PHASE 2]

**Overlap: ~55%.** Different *implementations* but same user job ("manage what the system has learned").

| Route | What it does |
|---|---|
| `/memory` (`MemoryPage.tsx`) | Persistent memory CRUD, full-text search, consolidation |
| `/local-vault/memory` (`MemoryLearningPage.tsx`) | Multi-Armed Bandit reward/learning dashboard |
| `/ai-learning` (`AILearningPage.tsx`) | Learning profiles, patterns, feedback |

**Proposal:** one "Memory & Learning" page at `/memory` with three tabs (Memories | Patterns | Bandit Stats). Internal IPC handlers stay separate (they're genuinely different systems); only the UI is unified.

---

## CLUSTER 7 — Network / Federation (4 → 2)  [PHASE 3]

**Overlap: ~40%.** Borderline 30% but worth considering.

| Sidebar entry | Route | Notes |
|---|---|---|
| Network › Federation | `/federation` | Cross-instance federation |
| Network › A2A Network | `/a2a-network` | Agent-to-agent network (different protocol) |
| Network › P2P Chat | `/decentralized-chat` | Person-to-person decentralized chat |
| Network › CNS | `/cns` | OpenClaw CNS gossip network |
| Network › Creator Network | `/creator-network` | Tabbed: Identity / Publish / Browse / Earnings / Compute |

These are **technically distinct** protocols, but they all answer "who/what is connected to me on the network?". Consider a single "Network" page with tabs OR clearer naming. **Defer to Phase 3** — needs design thinking, not a mechanical merge.

---

## CLUSTER 8 — Data / Vault (3 → 2)  [PHASE 3]

| Route | Notes |
|---|---|
| `/local-vault` | Secure encrypted local storage, audit log, privacy panel — KEEP |
| `/secrets-vault` | API keys, tokens — **MERGE as tab** inside `/local-vault` (it's the same job, different blob shape) |
| `/data-sovereignty` | Sovereignty controls — **MERGE as tab** inside `/local-vault` |
| `/offline-docs` | Local doc cache | KEEP separate (genuinely different — it's a doc reader) |

---

## CLUSTER 9 — OpenClaw Surfaces (3 → 1)  [PHASE 3]

| Route | Notes |
|---|---|
| `/openclaw-control` | Direct control of the OpenClaw runtime |
| `/openclaw-kanban` | Kanban board for tasks |
| `/system-services` ("AI Operations") | Service health/services panel |

These three together are the "OpenClaw cockpit". Single page `/openclaw` with tabs: Control | Tasks (Kanban) | Services. Saves 2 sidebar slots.

---

## NOT-OVERLAPS (kept distinct, don't touch)

These were checked and are **legitimately different features** despite similar names:

- **Hub** (`/hub`) vs **Apps** (`/`) — Hub is the dashboard, Apps is the project picker. Both should stay.
- **Code Studio** (`/code-studio`) vs **Coding Agent** (`/coding-agent`) — IDE vs agent runner. Different jobs.
- **Image / Video / Asset Studio** — different media pipelines, all justify their own surface.
- **Dataset Studio** vs **Scraping** — generation vs collection. Different sub-flows.
- **Calendar / Email / Integrations / Notifications** — distinct productivity primitives.
- **Local AI / Model Manager / Model Registry** — Terry said don't touch local AI. Honoring.
- **App Builder Studio** — Terry said don't touch.
- **Joy Assistant** (handler + canvas widget) — Terry said don't touch.

---

## Proposed New Sidebar (target shape after Phase 1+2)

```
WORKSPACE
  Hub
  Apps
  Chat

AI & AGENTS
  Local AI               (untouched — Terry's rule)
  Agents                 (absorbs swarm/autonomous/automation/production)
  Agent Orchestrator     (task cockpit — distinct UX)
  Coding Agent
  Skills
  Training Center
  Memory & Learning      (merges /memory, /ai-learning, /local-vault/memory tab)
  NLP Studio

BUILD
  App Builder            (untouched — Terry's rule)
  Code Studio
  Workflows
  Neural Builder
  CI/CD Pipelines
  Design System
  Image Studio
  Video Studio
  Asset Studio
  Scraping

DATA
  Library
  Documents
  Dataset Studio
  Local Vault            (absorbs secrets-vault + data-sovereignty as tabs)
  Offline Docs
  Model Registry         (read-only; Terry's rule)
  Model Manager          (Terry's rule)
  Benchmarks

NETWORK
  Smart Browser
  MCP Hub
  OpenClaw               (absorbs control + kanban + system-services)
  CNS
  P2P Chat
  A2A Network
  Federation
  AI Compute
  Creator Network

JOY MARKETPLACE
  Marketplace            (absorbs nft-marketplace + marketplace-explorer + on-chain + plugin-market)
  My Stores
  My Assets              (absorbs /my-marketplace-assets + /creator)
  Publish                (canonical universal wizard)

DISTRIBUTE             ← renamed from "Publish"
  Web Hosting            (was /deploy, absorbs /decentralized-deploy)
  Mobile & PWA           (was /app-publishing)

ME                     ← new section, absorbs Sovereign + Admin/Profile
  Identity               (DID + SSI + Public Profile + Account billing tabs)
  Token Economics
  Governance
  Email Hub
  Calendar
  Integrations
  Notifications

ADMIN
  Dashboard
  Team
  Analytics
  Backup & Restore
  Audit Log
```

**Net result:** 11 sections → 8, ~116 entries → ~62.

---

## Phased rollout

### Phase 1 — Ship now in this PR
1. Sidebar: drop duplicate Joy Marketplace mirrors (`/nft-marketplace`, `/marketplace`, `/on-chain-marketplace`, `/my-marketplace-assets`, `/creator`).
2. Sidebar: drop duplicate `Plugin Market` from Publish (will be reintroduced as a filter inside `/joy/marketplace` in Phase 2).
3. Sidebar: drop the redundant `Collab Activity` (already reachable via Collaboration Hub tab).
4. Pages stay routable but already render `JoyDeprecationBanner` — no broken links.

**Risk: very low.** Pages remain reachable. The only change is fewer sidebar buttons.

### Phase 2 — After Terry signs off on the proposed nav above
- Cluster 3 (Publish/Deploy merge)
- Cluster 4 (Agent pages merge — needs Terry to pick winners)
- Cluster 5 (Identity/Profile merge)
- Cluster 6 (Memory/Learning merge)

### Phase 3 — Bigger structural moves
- Cluster 7 (Network section)
- Cluster 8 (Data/Vault tabs)
- Cluster 9 (OpenClaw cockpit)

### Phase 4 — IPC handler consolidation (separate audit needed)
165 handler files is genuinely too many. Many are likely tiny stubs. Needs its own pass: group by domain, kill dead ones, merge thin ones. **This is post-UI work** — UI consolidation first.

---

## Open questions for Terry

1. **Cluster 4 (agent pages):** Of `/agent-swarm`, `/automation-orchestrator`, `/autonomous-agent`, `/autonomous-agent-production`, `AgenticOSDashboard` — which (if any) are first-class enough to keep their own sidebar entry? My default: absorb all into tabs under `/agents`, except keep `/agent-orchestrator` as the task cockpit.
2. **"Sovereign" section:** OK to dissolve into "Me" (with Token Economics + Governance under it)?
3. **"Admin" section:** Should `Profile` move into "Me" while Dashboard/Team/Analytics/Backup/Audit stay as Admin? I assumed yes.
4. **Plugin Marketplace:** OK to fold into Joy Marketplace as a `type=plugin` filter?
