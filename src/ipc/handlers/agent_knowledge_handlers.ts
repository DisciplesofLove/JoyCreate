/**
 * Agent Knowledge Base Handlers
 *
 * Per-agent retrievable knowledge. Each agent gets its own vector
 * collection. Documents can be added as raw text or fetched from a URL.
 * The collection is created on first write and reused for all subsequent
 * reads/writes.
 *
 * Channels (all throw on error):
 *   agent-kb:list-docs   ({ agentId })                    -> { success, documents }
 *   agent-kb:add-text    ({ agentId, title, content, source? }) -> { success, document }
 *   agent-kb:add-url     ({ agentId, url, title? })       -> { success, document }
 *   agent-kb:search      ({ agentId, query, topK? })      -> { success, results }
 *   agent-kb:delete-doc  ({ agentId, documentId })        -> { success }
 *   agent-kb:clear       ({ agentId })                    -> { success }
 */

import { app, ipcMain } from "electron";
import fs from "fs-extra";
import path from "path";
import log from "electron-log";

import {
  vectorStoreService,
  type CollectionId,
} from "@/lib/vector_store_service";

const logger = log.scope("agent-kb");

// agentId → collectionId. Persisted to disk so we can resolve quickly.
const agentToCollection: Map<string, CollectionId> = new Map();
let initialized = false;

function indexPath(): string {
  return path.join(app.getPath("userData"), "agents", "kb_index.json");
}

async function persistIndex(): Promise<void> {
  const obj: Record<string, string> = {};
  for (const [agentId, colId] of agentToCollection) obj[agentId] = colId;
  await fs.ensureDir(path.dirname(indexPath()));
  await fs.writeJson(indexPath(), obj, { spaces: 2 });
}

async function loadIndex(): Promise<void> {
  if (initialized) return;
  initialized = true;
  await vectorStoreService.initialize();
  try {
    if (await fs.pathExists(indexPath())) {
      const obj = (await fs.readJson(indexPath())) as Record<string, string>;
      for (const [agentId, colId] of Object.entries(obj)) {
        agentToCollection.set(agentId, colId as CollectionId);
      }
    }
  } catch (err) {
    logger.warn("Failed to load kb_index.json:", err);
  }
}

async function ensureCollection(agentId: string): Promise<CollectionId> {
  await loadIndex();
  const existing = agentToCollection.get(agentId);
  if (existing) return existing;
  const collection = await vectorStoreService.createCollection({
    name: `agent-kb-${agentId}`,
    description: `Knowledge base for agent ${agentId}`,
  });
  agentToCollection.set(agentId, collection.id);
  await persistIndex();
  return collection.id;
}

function getCollectionOrThrow(agentId: string): CollectionId {
  const id = agentToCollection.get(agentId);
  if (!id) throw new Error(`No knowledge base for agent ${agentId}`);
  return id;
}

/**
 * Best-effort plaintext extraction from an HTML body. Strips <script>,
 * <style>, all tags, and collapses whitespace. Truncates to avoid
 * blowing up the embedder on huge pages.
 */
function htmlToText(html: string, maxChars = 50_000): string {
  let s = html;
  s = s.replace(/<script[\s\S]*?<\/script>/gi, " ");
  s = s.replace(/<style[\s\S]*?<\/style>/gi, " ");
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(/<[^>]+>/g, " ");
  s = s.replace(/&nbsp;/g, " ");
  s = s.replace(/&amp;/g, "&");
  s = s.replace(/&lt;/g, "<");
  s = s.replace(/&gt;/g, ">");
  s = s.replace(/&quot;/g, '"');
  s = s.replace(/\s+/g, " ").trim();
  return s.slice(0, maxChars);
}

async function fetchUrlText(url: string): Promise<{ title?: string; text: string }> {
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (compatible; JoyCreateBot/1.0; +https://joycreate.local)",
    },
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching ${url}`);
  }
  const ct = (res.headers.get("content-type") || "").toLowerCase();
  const body = await res.text();
  if (ct.includes("application/json")) {
    return { text: body.slice(0, 50_000) };
  }
  if (ct.includes("text/html") || ct === "" || ct.includes("xhtml")) {
    const titleMatch = body.match(/<title[^>]*>([^<]+)<\/title>/i);
    return {
      title: titleMatch ? titleMatch[1].trim() : undefined,
      text: htmlToText(body),
    };
  }
  // Treat anything else as plain text.
  return { text: body.slice(0, 50_000) };
}

export function registerAgentKnowledgeHandlers(): void {
  loadIndex().catch((err) => logger.warn("Failed to init kb index:", err));

  ipcMain.handle(
    "agent-kb:list-docs",
    async (_event, args: { agentId: string }) => {
      try {
        if (!args?.agentId) throw new Error("agentId is required");
        await loadIndex();
        const colId = agentToCollection.get(args.agentId);
        if (!colId) return { success: true, documents: [] };
        const docs = await vectorStoreService.listDocuments(colId);
        return { success: true, documents: docs };
      } catch (err) {
        logger.error("list-docs failed:", err);
        throw err;
      }
    },
  );

  ipcMain.handle(
    "agent-kb:add-text",
    async (
      _event,
      args: {
        agentId: string;
        title: string;
        content: string;
        source?: string;
      },
    ) => {
      try {
        if (!args?.agentId) throw new Error("agentId is required");
        if (!args?.title?.trim()) throw new Error("title is required");
        if (!args?.content?.trim()) throw new Error("content is required");
        const colId = await ensureCollection(args.agentId);
        const [doc] = await vectorStoreService.addDocuments(colId, [
          {
            title: args.title.trim(),
            content: args.content,
            source: args.source,
            metadata: { addedAt: new Date().toISOString() },
          },
        ]);
        return { success: true, document: doc };
      } catch (err) {
        logger.error("add-text failed:", err);
        throw err;
      }
    },
  );

  ipcMain.handle(
    "agent-kb:add-url",
    async (
      _event,
      args: { agentId: string; url: string; title?: string },
    ) => {
      try {
        if (!args?.agentId) throw new Error("agentId is required");
        if (!args?.url?.trim()) throw new Error("url is required");
        let parsed: URL;
        try {
          parsed = new URL(args.url.trim());
        } catch {
          throw new Error("url is invalid");
        }
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          throw new Error("url must be http or https");
        }
        const { title, text } = await fetchUrlText(parsed.toString());
        if (!text.trim()) throw new Error("fetched page had no extractable text");
        const colId = await ensureCollection(args.agentId);
        const [doc] = await vectorStoreService.addDocuments(colId, [
          {
            title: args.title?.trim() || title || parsed.hostname + parsed.pathname,
            content: text,
            source: parsed.toString(),
            metadata: {
              addedAt: new Date().toISOString(),
              url: parsed.toString(),
            },
          },
        ]);
        return { success: true, document: doc };
      } catch (err) {
        logger.error("add-url failed:", err);
        throw err;
      }
    },
  );

  ipcMain.handle(
    "agent-kb:search",
    async (
      _event,
      args: { agentId: string; query: string; topK?: number },
    ) => {
      try {
        if (!args?.agentId) throw new Error("agentId is required");
        if (!args?.query?.trim()) throw new Error("query is required");
        await loadIndex();
        const colId = agentToCollection.get(args.agentId);
        if (!colId) return { success: true, results: [] };
        const results = await vectorStoreService.search({
          collectionId: colId,
          query: args.query.trim(),
          topK: args.topK ?? 5,
        });
        return { success: true, results };
      } catch (err) {
        logger.error("search failed:", err);
        throw err;
      }
    },
  );

  ipcMain.handle(
    "agent-kb:delete-doc",
    async (_event, args: { agentId: string; documentId: string }) => {
      try {
        if (!args?.agentId) throw new Error("agentId is required");
        if (!args?.documentId) throw new Error("documentId is required");
        const colId = getCollectionOrThrow(args.agentId);
        await vectorStoreService.deleteDocument(colId, args.documentId);
        return { success: true };
      } catch (err) {
        logger.error("delete-doc failed:", err);
        throw err;
      }
    },
  );

  ipcMain.handle(
    "agent-kb:clear",
    async (_event, args: { agentId: string }) => {
      try {
        if (!args?.agentId) throw new Error("agentId is required");
        const colId = agentToCollection.get(args.agentId);
        if (!colId) return { success: true };
        await vectorStoreService.deleteCollection(colId);
        agentToCollection.delete(args.agentId);
        await persistIndex();
        return { success: true };
      } catch (err) {
        logger.error("clear failed:", err);
        throw err;
      }
    },
  );

  /**
   * Internal helper for other handlers (e.g. agent runtime) to inject
   * KB context into a prompt. Exposed via export, not IPC.
   */
  logger.info("Agent Knowledge Base handlers registered");
}

/**
 * Internal API for agent runtime: retrieve top-K passages for a query.
 * Returns an empty array if the agent has no KB collection.
 */
export async function searchAgentKnowledgeInternal(
  agentId: string,
  query: string,
  topK = 5,
): Promise<
  Array<{ content: string; title?: string; source?: string; score: number }>
> {
  await loadIndex();
  const colId = agentToCollection.get(agentId);
  if (!colId) return [];
  const results = await vectorStoreService.search({
    collectionId: colId,
    query,
    topK,
  });
  return results.map((r) => ({
    content: r.content,
    title: r.title,
    source: r.source,
    score: r.score,
  }));
}
