/**
 * Blueprint skill resolver.
 *
 * Resolution order:
 *   1. `skills` table (by name; latest enabled row wins) → `kind: "skill_engine"`.
 *   2. Built-in adapter map → `kind: "builtin"`.
 *   3. Throws if neither matches.
 *
 * The adapter map is the single source of truth for the IPC channels a
 * Blueprint can call directly. Each adapter pins a stable IPC channel
 * (audited + executed by the orchestrator) plus a human description that
 * is fed into the Whitehat intent hash.
 */

import { eq, and, desc } from "drizzle-orm";
import { getDb } from "@/db";
import { skills } from "@/db/schema";
import type { Skill } from "@/types/skill_types";

/**
 * Bump when any built-in adapter's NAME, CHANNEL, DESCRIPTION, or
 * argMode changes — these are the fields hashed into `verify_intent`.
 * Adding a brand-new adapter does NOT require a bump (existing
 * blueprints stay valid). Renaming or repointing one DOES.
 */
export const BUILTIN_ADAPTERS_VERSION = "2.1.0";

/**
 * `argMode` controls how the orchestrator marshals `node.params` into
 * the IPC handler call:
 *   - "object"     → handler(event, params)                    (default)
 *   - "positional" → handler(event, ...params._args)           (e.g. get-app)
 *   - "none"       → handler(event)                            (no args)
 */
export type AdapterArgMode = "object" | "positional" | "none";

export interface BuiltinAdapter {
  name: string;
  /** IPC channel that backs this adapter. Dispatched via getInvokeHandler. */
  channel: string;
  /** Stable description; included in the manifest hash. */
  description: string;
  /** How params are passed to the handler. Default "object". */
  argMode?: AdapterArgMode;
  /** Human-readable param documentation for the NLP composer. NOT hashed. */
  paramDocs?: string;
}

const A = (
  name: string,
  channel: string,
  description: string,
  paramDocs?: string,
  argMode?: AdapterArgMode,
): BuiltinAdapter => ({ name, channel, description, paramDocs, argMode });

/**
 * Exhaustive adapter catalog. Every entry maps to an existing,
 * registered IPC handler. Grouped by domain for readability.
 */
export const BUILTIN_ADAPTERS: Record<string, BuiltinAdapter> = {
  // ─── Browser / scraping / web research ────────────────────────────
  "firecrawl-deep-scrape": A(
    "firecrawl-deep-scrape",
    "gauntlet:run",
    "Left Gauntlet headful scrape: Electron browser → Firecrawl → Whitehat verifier → IPLD anchor.",
    "{ url: string, sessionId?: string, extract?: string, maxPages?: number }",
  ),
  "web-fetch": A(
    "web-fetch",
    "tools:invoke",
    "Fetch a single URL (HTML readable text or JSON). Wraps the headless tool dispatcher.",
    '{ toolName: "web_fetch", args: { url, maxChars? } }',
  ),
  "web-search": A(
    "web-search",
    "tools:invoke",
    "Search the public web (DuckDuckGo) and return top results.",
    '{ toolName: "web_search", args: { query, maxResults? } }',
  ),
  "scraper-job-create": A(
    "scraper-job-create",
    "scraper:job:create",
    "Queue a local-first scraping job (multi-page, anti-bot aware).",
    "{ url: string, templateId?: string, schedule?: string }",
  ),

  // ─── n8n ──────────────────────────────────────────────────────────
  "n8n-trigger-workflow": A(
    "n8n-trigger-workflow",
    "n8n:workflow:execute",
    "Trigger an n8n workflow by id and optionally wait for completion.",
    "{ workflowId: string, data?: object, waitForCompletion?: boolean }",
  ),
  "n8n-create-workflow": A(
    "n8n-create-workflow",
    "n8n:workflow:create",
    "Create a new n8n workflow from JSON.",
    "{ workflow: object }",
  ),

  // ─── Marketplace / publishing / on-chain ──────────────────────────
  "publish-workflow": A(
    "publish-workflow",
    "workflow:publish-to-marketplace",
    "Publish a workflow YAML/JSON to the Joy Marketplace (DropERC1155 lazy mint + listing).",
    "{ workflowId?: string, name: string, description: string, content: string|object, price?: string, supply?: number }",
  ),
  "publish-asset": A(
    "publish-asset",
    "joy:asset:publish",
    "Universal asset publish (image/video/dataset/code/blueprint). Routes to the right on-chain mint.",
    "{ assetType: string, name: string, description: string, contentBase64?: string, contentRef?: string, price?: string, supply?: number }",
  ),

  // ─── Decentralized data / attestation ─────────────────────────────
  "celestia-anchor": A(
    "celestia-anchor",
    "celestia:blob:submit",
    "Anchor a content hash to the Celestia DA layer.",
    "{ data: string|Uint8Array, namespace?: string }",
  ),
  "ipld-receipt": A(
    "ipld-receipt",
    "ipld:receipt:create",
    "Mint an IPLD attestation receipt for a payload.",
    "{ payload: object, signer?: string }",
  ),
  "ssi-issue-credential": A(
    "ssi-issue-credential",
    "ssi:credential:issue",
    "Issue a verifiable credential signed by a local DID.",
    "{ holderDid: string, claims: object, issuerDid?: string, type?: string }",
  ),
  "ssi-anchor": A(
    "ssi-anchor",
    "ssi:credential:anchor",
    "Anchor a credential / presentation hash on-chain.",
    "{ credentialId: string }",
  ),
  "agent-provenance-attest": A(
    "agent-provenance-attest",
    "agent_provenance:attest",
    "Produce a signed provenance attestation for an agent's output (Whitehat verified-data).",
    "{ agentDid: string, contentHash: string, sourceUrls?: string[] }",
  ),

  // ─── LibreOffice / documents ──────────────────────────────────────
  "libreoffice-create": A(
    "libreoffice-create",
    "libreoffice:create",
    "Create a document/spreadsheet/presentation from a prompt or content body.",
    "{ name: string, prompt?: string, documentType?: 'document'|'spreadsheet'|'presentation', tone?: string }",
  ),
  "libreoffice-export": A(
    "libreoffice-export",
    "libreoffice:export",
    "Headless LibreOffice export to xlsx/csv/pdf/docx.",
    "{ documentId: string, format: 'xlsx'|'csv'|'pdf'|'docx' }",
  ),
  "libreoffice-update-content": A(
    "libreoffice-update-content",
    "libreoffice:update-content",
    "Replace a document's body.",
    "{ documentId: string, content: string }",
  ),

  // ─── Email / Calendar ─────────────────────────────────────────────
  "email-send": A(
    "email-send",
    "email:send",
    "Send an email via the connected provider.",
    "{ to: string|string[], subject: string, body: string, html?: boolean }",
  ),
  "email-scan": A(
    "email-scan",
    "email:scan",
    "Scan inbox for messages matching filters (subject/from/contains).",
    "{ since?: string, from?: string, subjectMatch?: string, max?: number }",
  ),
  "calendar-create-event": A(
    "calendar-create-event",
    "calendar:event:create",
    "Create a calendar event.",
    "{ title: string, start: string, end?: string, description?: string }",
  ),

  // ─── GitHub / deploy ──────────────────────────────────────────────
  "github-create-repo": A(
    "github-create-repo",
    "github:create-repo",
    "Create a new GitHub repository.",
    "{ name: string, private?: boolean, description?: string }",
  ),
  "github-push": A(
    "github-push",
    "github:push",
    "Commit and push the current app's working tree to the connected repo.",
    "{ appId: number, message: string, branch?: string }",
  ),
  "github-clone": A(
    "github-clone",
    "github:clone-repo-from-url",
    "Clone a public/private repo into a new app workspace.",
    "{ url: string, name?: string }",
  ),

  // ─── Studios (content generation) ─────────────────────────────────
  "image-studio-generate": A(
    "image-studio-generate",
    "image_studio:generate",
    "Generate an image via the configured Image Studio backend.",
    "{ prompt: string, model?: string, width?: number, height?: number, count?: number }",
  ),
  "video-studio-generate": A(
    "video-studio-generate",
    "video_studio:generate",
    "Generate a video via the configured Video Studio backend.",
    "{ prompt: string, model?: string, durationSec?: number }",
  ),
  "dataset-studio-create": A(
    "dataset-studio-create",
    "dataset_studio:create",
    "Create a new Dataset Studio dataset (manifest + items).",
    "{ name: string, description?: string, items?: Array<object> }",
  ),
  "dataset-studio-add-items": A(
    "dataset-studio-add-items",
    "dataset_studio:items:add",
    "Append items to an existing dataset.",
    "{ datasetId: string, items: Array<object> }",
  ),

  // ─── App lifecycle ────────────────────────────────────────────────
  "app-create": A(
    "app-create",
    "create-app",
    "Create a new JoyCreate app with initial scaffold and chat session.",
    "{ name: string }",
  ),
  "app-run": A(
    "app-run",
    "run-app",
    "Start a JoyCreate app's dev server.",
    "{ appId: number }",
  ),
  "app-stop": A(
    "app-stop",
    "stop-app",
    "Stop a running JoyCreate app.",
    "{ appId: number }",
  ),

  // ─── Agents / skills / missions ───────────────────────────────────
  "skill-execute": A(
    "skill-execute",
    "skill:execute",
    "Execute a registered skill by id with a free-form input.",
    "{ skillId: string, input: string }",
  ),
  "agent-run": A(
    "agent-run",
    "agent:execute",
    "Run an agent by id with the given user input.",
    "{ agentId: string|number, input: string }",
  ),
  "mission-create": A(
    "mission-create",
    "autonomous-agent:mission:create",
    "Spawn an autonomous mission (long-running, persisted).",
    "{ agentId?: string, type: string, description: string, inputs?: object }",
  ),
  "tool-invoke": A(
    "tool-invoke",
    "tools:invoke",
    "Invoke any registered headless tool by name (universal escape hatch).",
    "{ toolName: string, args: object }",
  ),

  // ─── Notifications / bots ─────────────────────────────────────────
  "telegram-send": A(
    "telegram-send",
    "telegram:send-message",
    "Send a Telegram message via the in-process bot.",
    "{ chatId: string, text: string }",
  ),
  "discord-send": A(
    "discord-send",
    "discord:send-message",
    "Send a Discord message via the in-process bot.",
    "{ channelId: string, text: string }",
  ),

  // ─── Vault / secrets ──────────────────────────────────────────────
  "vault-store": A(
    "vault-store",
    "vault:asset:create",
    "Store a content blob (encrypted) in the Sovereign Data Vault.",
    "{ name: string, contentBase64: string, mimeType?: string, tags?: string[] }",
  ),
  "vault-fetch": A(
    "vault-fetch",
    "vault:asset:get",
    "Fetch a vault asset by id.",
    "{ assetId: string }",
  ),

  // ─── Reasoning ────────────────────────────────────────────────────
  "opus-reasoning": A(
    "opus-reasoning",
    "blueprint:internal:reasoning",
    "Frontier-model reasoning step. Executed in-process via the resolved LLM (no IPC round-trip).",
    "{ system?: string, prompt: string, modelId?: string, maxTokens?: number, temperature?: number }",
  ),

  // ─── Hypercore peer layer (Holepunch) ─────────────────────────────
  "hypercore-append": A(
    "hypercore-append",
    "hyper:core:append",
    "Append a JSON entry to a per-subject hypercore log (tamper-evident, replicates over hyperswarm).",
    "{ scope: string, subjectId: string, entry: object }",
  ),
  "hyperbee-put": A(
    "hyperbee-put",
    "hyper:bee:put",
    "Write a key/value into a per-subject hyperbee (replicated KV store).",
    "{ scope: string, subjectId: string, key: string, value: any }",
  ),
  "hyperbee-get": A(
    "hyperbee-get",
    "hyper:bee:get",
    "Read a key from a per-subject hyperbee.",
    "{ scope: string, subjectId: string, key: string }",
  ),
  "hyperdrive-put": A(
    "hyperdrive-put",
    "hyper:drive:put",
    "Write a file into a per-subject hyperdrive (replicated content-addressed file system).",
    "{ scope: string, subjectId: string, path: string, data: string|Uint8Array }",
  ),
  "hyperdrive-get": A(
    "hyperdrive-get",
    "hyper:drive:get",
    "Read a file from a per-subject hyperdrive.",
    "{ scope: string, subjectId: string, path: string, encoding?: 'utf-8'|'base64' }",
  ),
  "hyperswarm-announce": A(
    "hyperswarm-announce",
    "hyper:topics:join",
    "Announce / join a hyperswarm topic for a subject so peers can discover and replicate.",
    "{ scope: string, subjectId: string, type?: 'log'|'bee'|'drive' }",
  ),
  "hyper-anchor": A(
    "hyper-anchor",
    "hyper:anchor:now",
    "Force-checkpoint every open hypercore topic to Celestia immediately (tamper-evident anchor).",
    "{}",
  ),
  "autobase-append": A(
    "autobase-append",
    "hyper:autobase:append",
    "Append a JSON entry to a multi-writer autobase log for a subject.",
    "{ scope: string, subjectId: string, entry: object }",
  ),
  "autobase-read": A(
    "autobase-read",
    "hyper:autobase:read",
    "Read the linearized view of a multi-writer autobase log.",
    "{ scope: string, subjectId: string, start?: number, end?: number }",
  ),
  "autobase-add-writer": A(
    "autobase-add-writer",
    "hyper:autobase:add-writer",
    "Authorize a remote peer's writer key to contribute to an autobase room.",
    "{ scope: string, subjectId: string, writerKeyHex: string }",
  ),
};

/** Convenience: array form for UI / composer prompts. */
export function listBuiltinAdapters(): BuiltinAdapter[] {
  return Object.values(BUILTIN_ADAPTERS);
}

export type ResolvedSkill =
  | { kind: "skill_engine"; skill: Skill }
  | { kind: "builtin"; adapter: BuiltinAdapter };

/** Throws if `name` cannot be resolved. */
export async function resolveSkill(name: string): Promise<ResolvedSkill> {
  // 1. skill_engine lookup
  const db = getDb();
  const row = await db
    .select()
    .from(skills)
    .where(and(eq(skills.name, name), eq(skills.enabled, true)))
    .orderBy(desc(skills.updatedAt))
    .limit(1);
  if (row.length > 0) {
    return { kind: "skill_engine", skill: rowToSkill(row[0]) };
  }

  // 2. built-in adapter map
  if (name in BUILTIN_ADAPTERS) {
    return { kind: "builtin", adapter: BUILTIN_ADAPTERS[name] };
  }

  throw new Error(
    `Blueprint skill "${name}" not found in skills table or built-in adapter map. ` +
      `Built-ins: ${Object.keys(BUILTIN_ADAPTERS).slice(0, 8).join(", ")}, … (${Object.keys(BUILTIN_ADAPTERS).length} total).`,
  );
}

/** Internal: drizzle row → Skill. Mirrors `skill_engine.rowToSkill`. */
function rowToSkill(row: typeof skills.$inferSelect): Skill {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    category: row.category as Skill["category"],
    type: row.type ?? "custom",
    implementationType: row.implementationType ?? "prompt",
    implementationCode: row.implementationCode,
    triggerPatterns: row.triggerPatterns ?? [],
    inputSchema: row.inputSchema,
    outputSchema: row.outputSchema,
    examples: row.examples ?? [],
    tags: row.tags ?? [],
    version: row.version ?? "1.0.0",
    authorId: row.authorId,
    publishStatus: row.publishStatus ?? "local",
    marketplaceId: row.marketplaceId,
    price: row.price ?? 0,
    currency: row.currency ?? "USD",
    downloads: row.downloads ?? 0,
    rating: row.rating ?? 0,
    enabled: row.enabled,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
