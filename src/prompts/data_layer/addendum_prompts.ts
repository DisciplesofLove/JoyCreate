/**
 * Read index prompts (Goldsky, The Graph) and Blob storage prompts.
 *
 * Read indexes are addendums — they augment the primary store with fast,
 * queryable indexed views (typically of onchain or event-stream data).
 * Blob storage prompts cover where large files (images, video, model
 * weights, receipts) actually live.
 */

import type { ReadIndexKind, BlobStorageKind } from "@/shared/data_layer_types";

// ── Read indexes ───────────────────────────────────────────────────────────

export const READ_INDEX_NONE_PROMPT = "";

export const GOLDSKY_AVAILABLE_PROMPT = `
# Read Index: Goldsky (Subgraph + Mirror)

This app uses **Goldsky** to query indexed onchain events with GraphQL.

## Setup
- Subgraph client lives at \`src/lib/subgraph_client.ts\` — REUSE it, do not create a parallel client.
- Endpoint configured via the existing Goldsky integration. Queries are GraphQL strings.

## Patterns
- Use \`<joy-subgraph-query>\` with a GraphQL document for any list/filter of onchain entities.
- Cache GraphQL responses in TanStack Query with a stable \`queryKey\`.
- For real-time, subscribe via Mirror websockets (only if the subgraph supports it).

DO NOT call RPCs directly to scan logs — use Goldsky for any read that spans more than one block.
`;

export const GOLDSKY_NOT_AVAILABLE_PROMPT = `
If the user asks for fast onchain queries, event history, or analytics over chain data, show:
<joy-add-integration provider="goldsky"></joy-add-integration>
`;

export const THEGRAPH_AVAILABLE_PROMPT = `
# Read Index: The Graph (decentralized subgraphs)

This app uses **The Graph** decentralized network to query indexed onchain data.

## Setup
- Endpoint configured per subgraph (Studio or decentralized network gateway).
- Use \`graphql-request\` or \`@apollo/client\` — pick one and stick with it.

## Patterns
- Use \`<joy-thegraph-query subgraph="...">\` for queries.
- Pay-per-query model on the decentralized network — cache aggressively in TanStack Query.

DO NOT generate subgraph manifests / mappings unless the user explicitly asks to author a new subgraph.
`;

export const THEGRAPH_NOT_AVAILABLE_PROMPT = `
If the user wants decentralized indexing for onchain data, show:
<joy-add-integration provider="thegraph"></joy-add-integration>
`;

export function readIndexPrompt(kind: ReadIndexKind, configured: boolean): string {
  if (kind === "none") return READ_INDEX_NONE_PROMPT;
  if (configured) {
    switch (kind) {
      case "goldsky":
        return GOLDSKY_AVAILABLE_PROMPT;
      case "thegraph":
        return THEGRAPH_AVAILABLE_PROMPT;
    }
  }
  switch (kind) {
    case "goldsky":
      return GOLDSKY_NOT_AVAILABLE_PROMPT;
    case "thegraph":
      return THEGRAPH_NOT_AVAILABLE_PROMPT;
  }
}

// ── Blob storage ───────────────────────────────────────────────────────────

export const BLOB_NONE_PROMPT = `
# Blob Storage: None

No blob storage is configured. Avoid generating file-upload UI or large-asset persistence.

If the user wants uploads, suggest:
<joy-add-integration provider="supabase-storage"></joy-add-integration> (centralized, simplest)
<joy-add-integration provider="ipfs-4everland"></joy-add-integration> (decentralized, pinned)
<joy-add-integration provider="arweave"></joy-add-integration> (permanent)
`;

export const BLOB_SUPABASE_AVAILABLE_PROMPT = `
# Blob Storage: Supabase Storage

Files live in **Supabase Storage** buckets. Use the existing Supabase client from the primary store integration — do not initialize a second one.

## Patterns
- Buckets via \`<joy-supabase-bucket name="...">\` (with RLS-style policies).
- Uploads: \`supabase.storage.from(bucket).upload(path, file)\`.
- Public URLs via \`getPublicUrl\`; signed URLs for private buckets via \`createSignedUrl\`.

Set a per-user prefix (e.g. \`{userId}/{filename}\`) and write a storage policy that restricts writes to that prefix.
`;

export const BLOB_IPFS_AVAILABLE_PROMPT = `
# Blob Storage: IPFS (4everland / Pinata / Helia)

Files are pinned to **IPFS** via the unified pinner at \`src/lib/joymarketplace/ipfs_pinner.ts\`. REUSE this — do not initialize a parallel IPFS client.

## Patterns
- Upload via the existing pinner (\`pinFile\`, \`pinJson\`).
- Store the returned CID in the primary database; render via an IPFS gateway URL.
- For permanent records, pair with Arweave or Celestia for redundancy.

DO NOT call browser-only IPFS APIs in server code — go through the pinner abstraction.
`;

export const BLOB_ARWEAVE_AVAILABLE_PROMPT = `
# Blob Storage: Arweave (permanent storage)

Files are uploaded permanently to **Arweave** (one-time payment, stored forever).

## Patterns
- Use \`<joy-pin-arweave>\` to upload. Bundlr / Turbo SDK handles the fee abstraction.
- Store the Arweave transaction ID in the primary database; render via \`https://arweave.net/{txId}\`.
- Best for immutable assets: published articles, model weights, NFT metadata.

DO NOT use Arweave for mutable / frequently-overwritten files — it's permanent and pay-per-byte.
`;

export const BLOB_CELESTIA_AVAILABLE_PROMPT = `
# Blob Storage: Celestia (data availability)

Files / payloads are posted to **Celestia** as data-availability blobs. Service at \`src/lib/celestia_blob_service.ts\` — REUSE it.

## Patterns
- Best for verifiable receipts, rollup data, or any payload that needs DA guarantees.
- Pair with the IPLD receipt service at \`src/lib/ipld_receipt_service.ts\` for content-addressed integrity.
- Blobs are pruned after the DA window — for permanent storage, also pin to IPFS or Arweave.

Use Celestia for DA, NOT as your only copy of important files.
`;

export function blobStoragePrompt(kind: BlobStorageKind, configured: boolean): string {
  if (kind === "none") return BLOB_NONE_PROMPT;
  if (!configured) {
    return `Blob storage provider "${kind}" is selected but not yet configured. Show <joy-add-integration provider="${kind}"></joy-add-integration> if the user attempts a file upload.`;
  }
  switch (kind) {
    case "supabase-storage":
      return BLOB_SUPABASE_AVAILABLE_PROMPT;
    case "ipfs-4everland":
    case "ipfs-helia":
      return BLOB_IPFS_AVAILABLE_PROMPT;
    case "arweave":
      return BLOB_ARWEAVE_AVAILABLE_PROMPT;
    case "celestia":
      return BLOB_CELESTIA_AVAILABLE_PROMPT;
  }
  return "";
}
