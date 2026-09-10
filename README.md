<p align="center">
  <a href="https://joycreate.app">
    <img src="https://github.com/user-attachments/assets/f6c83dfc-6ffd-4d32-93dd-4b9c46d17790" alt="JoyCreate — The Sovereign AI Operating System" width="100%" />
  </a>
</p>

<h1 align="center">JoyCreate</h1>

<h3 align="center">
  A sovereign AI operating system for your desktop<br/>
  <em>Local-first · Private · Open source</em>
</h3>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue?style=flat-square" alt="Apache 2.0" /></a>
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey?style=flat-square" alt="Platform" />
  <img src="https://img.shields.io/badge/Electron-38-47848F?style=flat-square&logo=electron" alt="Electron 38" />
  <img src="https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react" alt="React 19" />
  <img src="https://img.shields.io/badge/tests-1%2C181%20passing-brightgreen?style=flat-square" alt="Tests" />
  <img src="https://img.shields.io/badge/MCP%20tools-101-8B5CF6?style=flat-square" alt="MCP tools" />
  <a href="CONTRIBUTING.md"><img src="https://img.shields.io/badge/PRs-welcome-brightgreen?style=flat-square" alt="PRs welcome" /></a>
</p>

<p align="center">
  <strong>
    <a href="#quick-start">Quick start</a> ·
    <a href="#what-you-can-actually-do">Capabilities</a> ·
    <a href="#the-agent-economy">Agent economy</a> ·
    <a href="#agents-can-drive-the-whole-app">MCP</a> ·
    <a href="#architecture">Architecture</a> ·
    <a href="#what-needs-setup">Requirements</a> ·
    <a href="CONTRIBUTING.md">Contribute</a>
  </strong>
</p>

---

## What this is

JoyCreate is a desktop application that gives one person the tooling normally spread
across a dozen SaaS subscriptions — model fine-tuning, image and video generation,
dataset construction, document production, web scraping, app scaffolding, email triage,
and a marketplace to sell what you make — and runs it on **your** machine, against
**your** database, with **your** keys.

It is not a chat wrapper. The interesting part is underneath: a persistent agent
runtime with a durable run record, a policy-gated agent-to-agent economy with real
escrow, and an encrypted publishing pipeline where content is encrypted locally before
a single byte leaves the machine.

Two things are true and worth saying plainly:

- **The on-chain half is testnet.** Publishing targets Arbitrum Sepolia. Do not treat
  it as a place to sell things for real money yet.
- **Some capabilities need external tooling.** Fine-tuning needs Python and PyTorch;
  image generation needs a provider; documents need LibreOffice. The app detects what
  you have and tells you what is missing instead of failing halfway through. See
  [what needs setup](#what-needs-setup).

---

## Quick start

```bash
git clone https://github.com/DisciplesofLove/JoyCreate.git
cd JoyCreate
npm install
npm start
```

Node 20 or newer. First launch creates a SQLite database under your user data
directory and runs migrations automatically.

Nothing is required to boot — no account, no API key, no network. Add providers and
integrations as you need them.

---

## What you can actually do

### Build and run agents

Create agents with system prompts, tools and models; deploy them; compose them into
swarms with hierarchical, mesh or pipeline topologies. Agents are backed by a
**durable run record** — every run writes to a single activity table with a resume
cursor and per-step state.

This matters more than it sounds. Close the app mid-run and the run is not lost: at
next boot it is marked `interrupted`, and a run that recorded where it got to is
resumed from that point. A run with no cursor is failed with a reason rather than
silently replayed, because replaying a step whose side effects already happened is the
more expensive mistake.

**Background mode** keeps agents alive when every window is closed — a tray icon shows
how many runs are in progress, and quitting is an explicit choice rather than a
side effect of closing a window.

### Fine-tune models locally — LoRA and QLoRA

Train adapters on your own hardware, on your own datasets, without sending either
anywhere. The generated training scripts use PEFT with 4-bit NF4 quantisation and
double quant for QLoRA, so a 7B model fits on consumer hardware.

A preflight tells you what your machine can run **before** a job starts — it checks the
Python interpreter that actually answers, asks PyTorch directly whether it can see
CUDA, and names the packages you are missing:

```
Cannot start qlora training: Missing Python packages: transformers, peft,
datasets, accelerate. Install: pip install transformers peft datasets
accelerate bitsandbytes
```

Jobs persist to the database, so a run that takes six hours survives a restart, and a
finished adapter is registered in the model registry with its base model, rank, alpha
and dataset provenance — ready to use, merge or publish.

### Generate images and video

Image and video studios that dispatch to the provider you choose — OpenAI, Google,
Stability, Replicate, fal, Runway, Luma, xAI — or to a local backend (ComfyUI,
Automatic1111, LocalAI) so nothing leaves the machine. Every generation records a
provenance manifest: model, provider, prompt, parameters and seed.

Plus an ffmpeg-backed media pipeline for transcoding, trimming and batch processing.

### Build datasets

Create datasets by hand, generate synthetic data, or scrape them. Items are
content-addressed, versioned, and exportable — and a dataset is a first-class input to
fine-tuning, so the path from "collect data" to "trained adapter" stays inside one app.

### Scrape the web, properly

A four-engine scraper — static, browser, stealth and API — with automatic engine
selection based on what a probe of the target says it needs.

The parts that separate a scraper from a script are all present and wired:

- **Crawling** with a URL frontier, bloom-filter dedupe, scope rules and depth limits
- **Pagination** detected from the page itself, with a confidence floor so it does not
  request URLs that never existed
- **Proxy rotation** with per-proxy health tracking, so three failures retire a proxy
  instead of failing every remaining URL through it
- **Politeness**: robots.txt honoured by default, a per-domain token bucket, and an
  adaptive delay that backs off hard on 429/503 and eases on success

Extraction handles articles, feeds, sitemaps, structured data (JSON-LD, microdata,
OpenGraph), tables and custom CSS selectors, with PII detection on export.

### Produce real documents

LibreOffice-backed generation of documents, spreadsheets and presentations — ODT, DOCX,
XLSX, PPTX, PDF. Not markdown pretending to be a document: real files with headings,
sections, tables and styles that open in Word.

### Scaffold and deploy apps

Describe an app and get a working React + Vite + Tailwind project on disk, with git
initialised. Read and write its files, run its dev server, read its logs, and deploy it
to IPFS, 4everland, Fleek or Arweave — with a record of every deployment and the CIDs
it produced.

### Handle email with agents

Connect IMAP accounts; get unified inbox, search, threading, AI triage, summarisation,
daily digests and smart replies. The orchestrator runs rules against incoming mail and
can act on them — with a queue for anything that needs your approval first.

### Own your identity

Self-sovereign identity built in: create DIDs, issue W3C verifiable credentials, verify
credentials from others, revoke ones you issued. Credentials anchor to Celestia for
data availability. Nothing here depends on an identity provider.

---

## The agent economy

This is the part that does not exist elsewhere, so it is worth explaining properly.

Agents on your machine can **hire each other**, and the money is real ledger movement
rather than a simulation:

```
principal → listing → quote → hire (escrow) → invoke → verify (settle)
```

- **Principal** — an agent's economic identity: a DID, a payout address, a daily cap
  and a per-task cap.
- **Listing** — a capability offered for sale, with a price and a pricing model.
- **Quote** — the price frozen at request time, with an expiry, so a seller cannot
  reprice underneath a buyer.
- **Hire** — checks caps, debits the buyer, and escrows the funds. This is the step
  that moves money.
- **Invoke** — runs the work. A capability maps to a real handler, so an agent selling
  `document.create` produces an actual document.
- **Verify** — accepting pays the provider out of escrow and updates their reputation;
  rejecting refunds the buyer.

Escrow is safe in the ways that matter: a failed invocation refunds automatically, a
refund is idempotent so it cannot pay out twice, and a contract left mid-execution by a
crash is reconciled at the next boot rather than holding the buyer's funds forever.

Spending is constrained by a **policy engine** — deny rules, allow rules (which flip a
principal to default-deny), rolling-window spend limits, time windows, and
human-verification flags. All of it is enforced before funds move, not after.

---

## Agents can drive the whole app

JoyCreate runs an **MCP server** on `localhost:3777` exposing **101 tools**. Point
Claude Desktop, Cursor, or any MCP client at it and an agent can use the whole
application — not a curated subset:

| Area | What an agent can do |
|---|---|
| Agents | list, create, inspect, deploy, build swarms |
| Models | list local models, fine-tune with LoRA/QLoRA |
| Images & video | generate, list, process, run media pipelines |
| Datasets | create, list, generate synthetic data |
| Documents | create, export to PDF, list |
| Apps | scaffold, read/write files, run, deploy, list deployments |
| Skills & plugins | create, list, install |
| Knowledge | search the library, add to it |
| Email | accounts, unified inbox, search, triage, summarise, digest |
| Marketplace | browse, inspect, check a store, publish an asset |
| **Economy** | open an account, price work, quote, hire, invoke, verify, set policy |
| Compute | status, smart routing across providers |

Every side-effecting tool routes through one bridge, which is deliberate: it is the
single place a policy check has to be inserted to cover every agent-initiated action.

---

## Publishing: encrypted before it leaves

Selling something on Joy Marketplace runs one pipeline, and the wizard and the MCP tool
both drive it — there is no second path with weaker guarantees:

1. Content is encrypted locally with **AES-256-GCM**. The key is wrapped by **Lit
   Protocol**, so only a wallet holding the edition can unwrap it.
2. Ciphertext is split into chunks sized to the payload, each pinned separately to
   IPFS, with a Merkle root committed over the chunk hashes.
3. Metadata is written into a tokenId-named directory, because `uri(N)` is
   `baseURI + N` and the base URI is write-once with no setter.
4. `nextTokenIdToMint` is re-read immediately before minting, and the publish aborts on
   drift rather than minting over someone else's token.
5. The edition is lazy-minted on your store's own **DropERC1155** clone, addressed by
   an ENS name under `joymarketplace.io`.

A **dry run** walks the store, signer and token id without spending gas or pinning
anything. Use it first — it is the cheap way to discover a missing wallet key before
the irreversible half begins.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  Renderer — React 19 · TanStack Router · Tailwind · shadcn   │
│  138 pages · 100 routes · 139 hooks                          │
└───────────────────────────┬──────────────────────────────────┘
                            │  contextIsolation, allowlisted preload
┌───────────────────────────▼──────────────────────────────────┐
│  Main process — Electron 38                                  │
│  211 handler modules · ~2,400 registered IPC channels        │
│                                                              │
│   Agent runtime  ·  Policy kernel  ·  A2A economy            │
│   Scraping       ·  Fine-tuning    ·  Publish pipeline       │
│   Backup/restore ·  Audit log      ·  SSI                    │
└───────────────────────────┬──────────────────────────────────┘
                            │
        ┌───────────────────┼────────────────────┐
        │                   │                    │
┌───────▼──────┐   ┌────────▼────────┐   ┌───────▼────────┐
│ SQLite       │   │ MCP server      │   │ Chain + IPFS   │
│ Drizzle ORM  │   │ :3777 · 101     │   │ Arbitrum       │
│ 80 migrations│   │ tools           │   │ Sepolia · Lit  │
└──────────────┘   └─────────────────┘   └────────────────┘
```

**Conventions that keep it coherent** (see [CLAUDE.md](CLAUDE.md) and
[AGENTS.md](AGENTS.md)):

- Handlers **throw** on failure. They never return `{ success: false }` inside a
  success envelope — a caller reading an error out of a successful result treats it as
  data, which is how failures get paid for.
- Every renderer-reachable channel is explicitly allowlisted in the preload.
- Long-running work writes to the shared activity record, so one place answers "what is
  this machine doing".

Further reading: [architecture](docs/architecture.md) ·
[agent architecture](docs/agent_architecture.md) · [skills](SKILLS.md) ·
[marketplace integration](docs/JOYMARKETPLACE_INTEGRATION.md) ·
[dataset studio](docs/JOYCREATE_DATASET_STUDIO_ARCHITECTURE.md)

---

## What needs setup

JoyCreate boots and does useful work with none of this. Each row is what a specific
capability needs, and the app reports what is missing rather than failing mid-job.

| Capability | Needs | Without it |
|---|---|---|
| Chat, agents, workflows | nothing | works |
| Local models | Ollama, or a local model file | cloud providers only |
| Cloud models | a provider API key | local only |
| Image / video generation | a provider key, or ComfyUI / A1111 / LocalAI | studios list past work; generation reports the missing provider |
| **LoRA** fine-tuning | Python 3 + `torch transformers peft datasets accelerate` | preflight names the missing packages |
| **QLoRA** fine-tuning | the above, plus **CUDA** and `bitsandbytes` | refused up front — 4-bit is a CUDA kernel and cannot run on CPU |
| Documents | LibreOffice | document tools report it is not installed |
| Video processing | ffmpeg on PATH | media pipeline reports it is missing |
| Publishing | a funded Arbitrum Sepolia wallet + a store ENS name you own | dry run explains what is missing |
| Email | IMAP credentials | email surfaces are empty |

---

## Project status

**v0.32.0-beta.** Actively developed, and honest about maturity.

- **Solid**: agent runtime and crash recovery, scraping, documents, app scaffolding,
  datasets, backup/restore, the MCP surface, the publish pipeline's encryption and
  pinning.
- **Testnet**: everything on-chain — publishing, drops, x402 payments, mandates.
- **Early**: multi-user/team features, the captcha-handling path in the scraper, and
  parts of Data Studio (version control, lineage, dashboards) that are registered as
  explicit no-ops rather than pretending to work.

If a surface in this app cannot do something, the goal is that it says so. Finding a
place where it does not is a bug worth reporting.

```bash
npm test          # 1,181 tests across 80 files
npx tsc --noEmit  # type check
npm run lint
```

---

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

The most useful things you can send:

- **Bug reports where the app lied to you.** A button that reports success without
  doing anything is the highest-priority class of bug in this project.
- **Provider integrations** — a new image, video or model backend.
- **A2A capability executors** — teach agents a new thing they can sell.
- **Platform testing.** Most development happens on Windows; macOS and Linux reports
  are valuable.

Security issues: please follow [SECURITY.md](SECURITY.md) rather than opening a public
issue.

---

## License

Apache 2.0, except `src/pro/`, which is licensed under the Functional Source License
(FSL-1.1-ALv2) and converts to Apache 2.0 over time. See [LICENSE](LICENSE) and
[src/pro/LICENSE](src/pro/LICENSE).

<p align="center">
  <sub>Built for people who would rather own their tools than rent them.</sub>
</p>
