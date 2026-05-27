/**
 * Primary store prompts for the Data + Backend Layer.
 *
 * Each store has two variants:
 *   - AVAILABLE: injected when the provider is configured and ready
 *   - NOT_AVAILABLE: injected when the user hasn't connected it yet,
 *     so the builder knows to emit <joy-add-integration provider="..."> instead
 *     of broken setup code.
 *
 * The Supabase variants re-export the canonical strings from the existing
 * src/prompts/supabase_prompt.ts so there's one source of truth.
 */

import {
  SUPABASE_AVAILABLE_SYSTEM_PROMPT,
  SUPABASE_NOT_AVAILABLE_SYSTEM_PROMPT,
} from "@/prompts/supabase_prompt";
import type { DataLayerKind } from "@/shared/data_layer_types";

// ── none (localStorage / IndexedDB) ─────────────────────────────────────────
export const NONE_AVAILABLE_PROMPT = `
# Data Storage: Client-side only

No backend database is configured for this app. Persist data using:
- \`localStorage\` for small key/value state (under ~5MB)
- \`IndexedDB\` (via \`idb\` or \`Dexie.js\`) for larger structured data
- React state / Jotai atoms for ephemeral UI state

DO NOT:
- Generate code that calls Supabase, Tableland, Ceramic, Gun, OrbitDB, or WeaveDB.
- Add database driver dependencies.
- Reference auth providers, RLS, or server-side sessions.

If the user explicitly asks for a backend or persistent multi-device data, suggest:
<joy-add-integration provider="supabase"></joy-add-integration> (recommended hybrid)
<joy-add-integration provider="tableland"></joy-add-integration> (onchain SQL)
<joy-add-integration provider="gundb"></joy-add-integration> (local-first p2p sync)
`;

export const NONE_NOT_AVAILABLE_PROMPT = ""; // never relevant — "none" is always available

// ── Tableland (onchain SQL) ─────────────────────────────────────────────────
export const TABLELAND_AVAILABLE_PROMPT = `
# Data Storage: Tableland (onchain SQL)

This app uses **Tableland** for decentralized SQL. Tables are owned by ERC-721 NFTs on EVM chains.

## Setup
- Client lives at \`src/integrations/tableland/client.ts\` — initialize with the existing thirdweb signer from \`@/config/joy-wallet-providers\`.
- Add dependency: \`@tableland/sdk\`.
- The user's wallet must be connected before any write. Read queries are public.

## Schema
Use \`<joy-create-table-tableland>\` to provision a new owned table:
\`\`\`
<joy-create-table-tableland name="todos" schema="id integer primary key, title text not null, done integer default 0, owner text not null"></joy-create-table-tableland>
\`\`\`

## Writes
Use \`<joy-execute-sql-tableland>\` for INSERT/UPDATE/DELETE. Always include the connected wallet address in an \`owner\` column and filter reads by it for per-user data.

## Reads
Public reads can use the Tableland Gateway HTTP API (no wallet). Cache with TanStack Query.

DO NOT use Postgres-specific features (RLS, jsonb, triggers, sequences). Tableland is SQLite-compatible.
`;

export const TABLELAND_NOT_AVAILABLE_PROMPT = `
If the user asks for onchain SQL data, decentralized tables, or NFT-owned data, show:
<joy-add-integration provider="tableland"></joy-add-integration>
`;

// ── Ceramic / ComposeDB (DID streams) ──────────────────────────────────────
export const CERAMIC_AVAILABLE_PROMPT = `
# Data Storage: Ceramic ComposeDB (DID streams)

This app uses **Ceramic ComposeDB** for decentralized user profiles and social-style data anchored to DIDs.

## Setup
- Client at \`src/integrations/ceramic/client.ts\` using \`@ceramicnetwork/http-client\` + \`@composedb/client\`.
- Auth is wallet-based (DID:pkh). Reuse the existing thirdweb signer.
- Schemas (composites) defined via \`<joy-define-composite name="...">\` blocks. Composites are GraphQL-shaped models.

## Patterns
- One composite per logical type (Profile, Post, Follow). Keep them small.
- Use \`<joy-write-stream model="Profile">\` to create/update; \`<joy-read-stream>\` for queries.
- Owner is implicit from the connecting DID — do NOT add \`owner\` columns.

## Best for
User profiles, social graphs, comments, follows. NOT for high-volume transactional data.
`;

export const CERAMIC_NOT_AVAILABLE_PROMPT = `
If the user wants wallet-based user profiles, decentralized identity, or social-style data, show:
<joy-add-integration provider="ceramic"></joy-add-integration>
`;

// ── GunDB (local-first p2p) ────────────────────────────────────────────────
export const GUNDB_AVAILABLE_PROMPT = `
# Data Storage: GunDB (local-first p2p)

This app uses **GunDB** — a local-first, peer-to-peer graph database with offline-first sync.

## Setup
- Add dependency: \`gun\`.
- Initialize a single Gun instance at \`src/integrations/gun/client.ts\` with the configured peer relays.
- For encryption use SEA (Gun's built-in crypto). Generate the user's key pair from the connected wallet signature so users don't manage two keypairs.

## Patterns
- \`gun.get('namespace').get(key).put(value)\` — writes propagate to all peers.
- \`gun.get('namespace').get(key).on(cb)\` — subscribe to changes (offline-safe).
- Keep keys hierarchical and avoid storing large blobs (use the blob layer for files).

## Best for
Offline-first apps, real-time collaboration, chat, peer-to-peer notes.

DO NOT mix Gun with SQL paradigms. There are no joins or transactions.
`;

export const GUNDB_NOT_AVAILABLE_PROMPT = `
If the user wants offline-first sync, peer-to-peer data, or a local-first app, show:
<joy-add-integration provider="gundb"></joy-add-integration>
`;

// ── OrbitDB (CRDT over IPFS) ───────────────────────────────────────────────
export const ORBITDB_AVAILABLE_PROMPT = `
# Data Storage: OrbitDB (CRDT over IPFS)

This app uses **OrbitDB** — a CRDT-based database layered on top of IPFS pubsub. Data lives on IPFS, peers replicate changes.

## Setup
- Add dependencies: \`@orbitdb/core\`, \`@orbitdb/voyager\` (optional pin relay).
- Reuse the embedded Helia node from \`src/lib/joymarketplace/ipfs_pinner.ts\`.
- Initialize at \`src/integrations/orbitdb/client.ts\`. Identity provider: derive from the connected wallet (same keypair as SEA / DID).

## Database types
- \`keyvalue\` — simple K/V
- \`documents\` — JSON documents with field queries
- \`events\` — append-only log
- \`counter\` — distributed counter

Use \`<joy-create-orbit-db type="documents" name="posts">\`. Reads return RxJS-style observables; pipe through TanStack Query for caching.

## Best for
Decentralized social apps, federated content, p2p marketplaces. Pairs well with IPFS blob storage.
`;

export const ORBITDB_NOT_AVAILABLE_PROMPT = `
If the user wants IPFS-native databases, CRDT sync, or fully decentralized peer-to-peer storage with structured data, show:
<joy-add-integration provider="orbitdb"></joy-add-integration>
`;

// ── WeaveDB (Arweave NoSQL) ────────────────────────────────────────────────
export const WEAVEDB_AVAILABLE_PROMPT = `
# Data Storage: WeaveDB (Arweave NoSQL)

This app uses **WeaveDB** — a Firestore-style NoSQL database with permanent storage on Arweave. Writes are trustless and immutable.

## Setup
- Add dependency: \`weavedb-sdk\`.
- Initialize at \`src/integrations/weavedb/client.ts\` with the app's WeaveDB contract ID.
- Auth via wallet (EVM/Arweave). Reuse the thirdweb signer for EVM-mode WeaveDB.

## Schema + rules
- Define collections with \`<joy-weavedb-schema collection="posts">\` (JSON schema).
- Define access rules with \`<joy-weavedb-rules collection="posts">\` (JSON predicate language).
- Always set rules — default-deny is the secure choice.

## Patterns
- \`db.add({...}, "posts")\` / \`db.get("posts")\` — Firestore-shaped API.
- Reads are cached by the SDK; pipe through TanStack Query for component-level caching.
- Pair with \`<joy-pin-arweave>\` for permanent blob storage so the entire app is immutable.

## Best for
Permanent records, audit logs, immutable archives, decentralized publishing.
`;

export const WEAVEDB_NOT_AVAILABLE_PROMPT = `
If the user wants permanent storage on Arweave, immutable data, or trustless NoSQL, show:
<joy-add-integration provider="weavedb"></joy-add-integration>
`;

// ── Re-export Supabase canonical strings under the registry names ──────────
export {
  SUPABASE_AVAILABLE_SYSTEM_PROMPT as SUPABASE_AVAILABLE_PROMPT,
  SUPABASE_NOT_AVAILABLE_SYSTEM_PROMPT as SUPABASE_NOT_AVAILABLE_PROMPT,
};

// ── Dispatch table ─────────────────────────────────────────────────────────
export function primaryStorePrompt(kind: DataLayerKind, configured: boolean): string {
  if (configured) {
    switch (kind) {
      case "none":
        return NONE_AVAILABLE_PROMPT;
      case "supabase":
        return SUPABASE_AVAILABLE_SYSTEM_PROMPT;
      case "tableland":
        return TABLELAND_AVAILABLE_PROMPT;
      case "ceramic":
        return CERAMIC_AVAILABLE_PROMPT;
      case "gundb":
        return GUNDB_AVAILABLE_PROMPT;
      case "orbitdb":
        return ORBITDB_AVAILABLE_PROMPT;
      case "weavedb":
        return WEAVEDB_AVAILABLE_PROMPT;
    }
  }
  switch (kind) {
    case "none":
      return NONE_AVAILABLE_PROMPT; // "none" doesn't need configuring
    case "supabase":
      return SUPABASE_NOT_AVAILABLE_SYSTEM_PROMPT;
    case "tableland":
      return TABLELAND_NOT_AVAILABLE_PROMPT;
    case "ceramic":
      return CERAMIC_NOT_AVAILABLE_PROMPT;
    case "gundb":
      return GUNDB_NOT_AVAILABLE_PROMPT;
    case "orbitdb":
      return ORBITDB_NOT_AVAILABLE_PROMPT;
    case "weavedb":
      return WEAVEDB_NOT_AVAILABLE_PROMPT;
  }
}
