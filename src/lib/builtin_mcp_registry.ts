/**
 * Built-in MCP registry.
 *
 * Provides a curated set of in-process "MCP tools" that agents can call
 * via the standard `executeMcpTool` path without needing an external
 * MCP server process. Each entry follows MCP tool conventions
 * (`name`, `description`, `inputSchema`) and a typed `invoke()` async
 * function that wraps existing JoyCreate services or stdlib APIs.
 *
 * To add a new built-in tool:
 *   1. Define a `BuiltinMcpTool` with a JSON-schema input.
 *   2. Implement `invoke(input)` — throw on error per AGENTS.md.
 *   3. Register it in `BUILTIN_MCP_TOOLS` below.
 *
 * Agents reference a built-in tool with `tool.config = { serverName: "builtin", toolName: <id> }`.
 */

import { vectorStoreService } from "./vector_store_service";
import type { CollectionId } from "@/types/sovereign_stack_types";

export interface BuiltinMcpToolInputSchema {
  type: "object";
  properties: Record<string, { type: string; description?: string; default?: unknown }>;
  required?: string[];
}

export interface BuiltinMcpTool {
  /** Stable identifier used as `toolName` in `tool.config`. */
  id: string;
  /** Display name for the tool picker. */
  name: string;
  /** Human-readable description for LLM tool selection. */
  description: string;
  /** Category for grouping in the UI. */
  category: "web" | "knowledge" | "system" | "data";
  /** JSON schema for `invoke` input. */
  inputSchema: BuiltinMcpToolInputSchema;
  /** In-process implementation. Throws on failure. */
  invoke: (input: any, context?: BuiltinMcpInvokeContext) => Promise<any>;
}

export interface BuiltinMcpInvokeContext {
  /** Agent id triggering the call — used for per-agent scoping. */
  agentId?: string;
}

// ────────────────────────────────────────────────────────────────────────────
// Helper: convert HTML to plain text (mirrors agent_knowledge_handlers).
// ────────────────────────────────────────────────────────────────────────────
function htmlToText(html: string, maxChars = 50_000): string {
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length > maxChars) text = text.slice(0, maxChars);
  return text;
}

// ────────────────────────────────────────────────────────────────────────────
// Registry entries
// ────────────────────────────────────────────────────────────────────────────

const webFetchTool: BuiltinMcpTool = {
  id: "web.fetch",
  name: "Fetch URL",
  description:
    "Fetch a URL (http/https only) and return its plain-text content. HTML is stripped to text; JSON is returned as a string.",
  category: "web",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "Absolute http(s) URL to fetch." },
      maxChars: {
        type: "number",
        description: "Maximum characters to return (default 50000).",
      },
    },
    required: ["url"],
  },
  async invoke(input) {
    const url = String(input?.url ?? "");
    const maxChars = Number(input?.maxChars ?? 50_000);
    if (!url) throw new Error("web.fetch: 'url' is required");
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error("web.fetch: invalid URL");
    }
    if (!/^https?:$/.test(parsed.protocol)) {
      throw new Error("web.fetch: only http and https are allowed");
    }
    const res = await fetch(url, {
      headers: { "User-Agent": "JoyCreate-Agent/1.0" },
    });
    if (!res.ok) {
      throw new Error(`web.fetch: HTTP ${res.status} ${res.statusText}`);
    }
    const contentType = res.headers.get("content-type") ?? "";
    const body = await res.text();
    let text: string;
    if (contentType.includes("html")) {
      text = htmlToText(body, maxChars);
    } else {
      text = body.length > maxChars ? body.slice(0, maxChars) : body;
    }
    return {
      url,
      status: res.status,
      contentType,
      length: text.length,
      content: text,
    };
  },
};

const vectorSearchTool: BuiltinMcpTool = {
  id: "vector.search",
  name: "Vector search",
  description:
    "Search a vector collection for the top-K most relevant passages. Returns content + score + metadata.",
  category: "knowledge",
  inputSchema: {
    type: "object",
    properties: {
      collectionId: { type: "string", description: "Vector collection id." },
      query: { type: "string", description: "Search query text." },
      topK: { type: "number", description: "Number of results (default 5)." },
    },
    required: ["collectionId", "query"],
  },
  async invoke(input) {
    const collectionId = String(input?.collectionId ?? "") as CollectionId;
    const query = String(input?.query ?? "");
    const topK = Math.max(1, Math.min(20, Number(input?.topK ?? 5)));
    if (!collectionId) throw new Error("vector.search: 'collectionId' required");
    if (!query) throw new Error("vector.search: 'query' required");
    await vectorStoreService.initialize();
    const results = await vectorStoreService.search({
      collectionId,
      query,
      topK,
      includeMetadata: true,
    });
    return {
      collectionId,
      count: results.length,
      results: results.map((r) => ({
        id: r.id,
        content: r.content,
        score: r.score,
        source: r.source,
        metadata: r.metadata,
      })),
    };
  },
};

const kbSearchTool: BuiltinMcpTool = {
  id: "kb.search",
  name: "Knowledge-base search",
  description:
    "Search THIS agent's private knowledge base. Returns top-K passages.",
  category: "knowledge",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query text." },
      topK: { type: "number", description: "Number of results (default 5)." },
    },
    required: ["query"],
  },
  async invoke(input, context) {
    const query = String(input?.query ?? "");
    const topK = Math.max(1, Math.min(20, Number(input?.topK ?? 5)));
    if (!query) throw new Error("kb.search: 'query' required");
    if (!context?.agentId) {
      throw new Error("kb.search: agent context required");
    }
    // Lazy import to avoid pulling agent handlers into this module's load graph.
    const { searchAgentKnowledgeInternal } = await import(
      "@/ipc/handlers/agent_knowledge_handlers"
    );
    const passages = await searchAgentKnowledgeInternal(
      context.agentId,
      query,
      topK,
    );
    return {
      count: passages.length,
      results: passages,
    };
  },
};

const listCollectionsTool: BuiltinMcpTool = {
  id: "vector.listCollections",
  name: "List vector collections",
  description: "List all vector collections available in the local store.",
  category: "knowledge",
  inputSchema: {
    type: "object",
    properties: {},
  },
  async invoke() {
    await vectorStoreService.initialize();
    const cols = vectorStoreService.listCollections();
    return {
      count: cols.length,
      collections: cols.map((c) => ({
        id: c.id,
        name: c.name,
        documentCount: (c as any).documentCount ?? 0,
      })),
    };
  },
};

const timeNowTool: BuiltinMcpTool = {
  id: "system.time",
  name: "Current time",
  description: "Get the current UTC time as ISO-8601 plus locale-formatted strings.",
  category: "system",
  inputSchema: {
    type: "object",
    properties: {
      timezone: {
        type: "string",
        description: "IANA timezone (default UTC).",
      },
    },
  },
  async invoke(input) {
    const tz = String(input?.timezone ?? "UTC");
    const now = new Date();
    let local: string;
    try {
      local = new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        dateStyle: "full",
        timeStyle: "long",
      }).format(now);
    } catch {
      throw new Error(`system.time: invalid timezone '${tz}'`);
    }
    return {
      iso: now.toISOString(),
      epochMs: now.getTime(),
      timezone: tz,
      local,
    };
  },
};

// ────────────────────────────────────────────────────────────────────────────
// GitHub tools (use stored OAuth token from main settings)
// ────────────────────────────────────────────────────────────────────────────

async function getGithubToken(): Promise<string> {
  const { readSettings } = await import("@/main/settings");
  const token = readSettings().githubAccessToken?.value;
  if (!token) {
    throw new Error("github: not authenticated (no access token in settings)");
  }
  return token;
}

const GH_API = "https://api.github.com";
const GH_HEADERS = (token: string) => ({
  Authorization: `Bearer ${token}`,
  Accept: "application/vnd.github+json",
  "User-Agent": "JoyCreate-Agent/1.0",
});

const githubMeTool: BuiltinMcpTool = {
  id: "github.me",
  name: "GitHub: current user",
  description: "Get the authenticated GitHub user's profile (login, name, email).",
  category: "data",
  inputSchema: { type: "object", properties: {} },
  async invoke() {
    const token = await getGithubToken();
    const res = await fetch(`${GH_API}/user`, { headers: GH_HEADERS(token) });
    if (!res.ok) throw new Error(`github.me: HTTP ${res.status}`);
    const u = await res.json();
    return {
      login: u.login,
      name: u.name,
      email: u.email,
      bio: u.bio,
      publicRepos: u.public_repos,
      followers: u.followers,
    };
  },
};

const githubSearchReposTool: BuiltinMcpTool = {
  id: "github.searchRepos",
  name: "GitHub: search repos",
  description:
    "Search public GitHub repositories. Returns up to 20 top matches with name, description, stars.",
  category: "data",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "GitHub repo search query." },
      perPage: { type: "number", description: "Results per page (1-30, default 10)." },
    },
    required: ["query"],
  },
  async invoke(input) {
    const query = String(input?.query ?? "");
    const perPage = Math.max(1, Math.min(30, Number(input?.perPage ?? 10)));
    if (!query) throw new Error("github.searchRepos: 'query' required");
    const token = await getGithubToken();
    const url = `${GH_API}/search/repositories?q=${encodeURIComponent(query)}&per_page=${perPage}`;
    const res = await fetch(url, { headers: GH_HEADERS(token) });
    if (!res.ok) throw new Error(`github.searchRepos: HTTP ${res.status}`);
    const data = await res.json();
    return {
      totalCount: data.total_count,
      items: (data.items ?? []).map((r: any) => ({
        fullName: r.full_name,
        description: r.description,
        url: r.html_url,
        stars: r.stargazers_count,
        language: r.language,
        updatedAt: r.updated_at,
      })),
    };
  },
};

const githubListMyReposTool: BuiltinMcpTool = {
  id: "github.listMyRepos",
  name: "GitHub: list my repos",
  description: "List the authenticated user's repositories (newest first).",
  category: "data",
  inputSchema: {
    type: "object",
    properties: {
      perPage: { type: "number", description: "Results per page (default 30, max 100)." },
    },
  },
  async invoke(input) {
    const perPage = Math.max(1, Math.min(100, Number(input?.perPage ?? 30)));
    const token = await getGithubToken();
    const res = await fetch(
      `${GH_API}/user/repos?per_page=${perPage}&sort=updated`,
      { headers: GH_HEADERS(token) },
    );
    if (!res.ok) throw new Error(`github.listMyRepos: HTTP ${res.status}`);
    const repos = await res.json();
    return {
      count: repos.length,
      repos: repos.map((r: any) => ({
        fullName: r.full_name,
        private: r.private,
        description: r.description,
        url: r.html_url,
        stars: r.stargazers_count,
        updatedAt: r.updated_at,
      })),
    };
  },
};

// ────────────────────────────────────────────────────────────────────────────
// Embeddings (uses EmbeddingPipeline singleton)
// ────────────────────────────────────────────────────────────────────────────

const embeddingEmbedTool: BuiltinMcpTool = {
  id: "embedding.embed",
  name: "Embed text",
  description:
    "Generate a vector embedding for a single text string using the active embedding model.",
  category: "knowledge",
  inputSchema: {
    type: "object",
    properties: {
      text: { type: "string", description: "Text to embed." },
    },
    required: ["text"],
  },
  async invoke(input) {
    const text = String(input?.text ?? "");
    if (!text) throw new Error("embedding.embed: 'text' required");
    const { embeddingPipeline } = await import("./embedding_pipeline");
    const vec = await embeddingPipeline.embedQuery(text);
    return { dimensions: vec.length, embedding: vec };
  },
};

// ────────────────────────────────────────────────────────────────────────────
// Public registry
// ────────────────────────────────────────────────────────────────────────────

export const BUILTIN_MCP_TOOLS: ReadonlyArray<BuiltinMcpTool> = [
  webFetchTool,
  vectorSearchTool,
  kbSearchTool,
  listCollectionsTool,
  timeNowTool,
  githubMeTool,
  githubSearchReposTool,
  githubListMyReposTool,
  embeddingEmbedTool,
];

const byId = new Map<string, BuiltinMcpTool>(
  BUILTIN_MCP_TOOLS.map((t) => [t.id, t]),
);

/**
 * Look up a built-in tool by id. Returns undefined if not found.
 */
export function getBuiltinMcpTool(id: string): BuiltinMcpTool | undefined {
  return byId.get(id);
}

/**
 * Invoke a built-in tool by id. Throws if not found or on tool error.
 */
export async function invokeBuiltinMcpTool(
  id: string,
  input: any,
  context?: BuiltinMcpInvokeContext,
): Promise<any> {
  const tool = byId.get(id);
  if (!tool) throw new Error(`Unknown built-in MCP tool: ${id}`);
  return tool.invoke(input, context);
}

/**
 * Public metadata-only view (no `invoke`) suitable for sending to the renderer.
 */
export interface BuiltinMcpToolDescriptor {
  id: string;
  name: string;
  description: string;
  category: BuiltinMcpTool["category"];
  inputSchema: BuiltinMcpToolInputSchema;
}

export function listBuiltinMcpToolDescriptors(): BuiltinMcpToolDescriptor[] {
  return BUILTIN_MCP_TOOLS.map(({ id, name, description, category, inputSchema }) => ({
    id,
    name,
    description,
    category,
    inputSchema,
  }));
}
