/**
 * Blueprint skill resolver.
 *
 * Resolution order:
 *   1. `skills` table (by name; latest enabled row wins) → `kind: "skill_engine"`.
 *   2. Built-in adapter map → `kind: "builtin"`.
 *   3. Throws if neither matches.
 *
 * The adapter map is intentionally tiny and typed so Blueprints can refer
 * to the well-known channels (scraper, libreoffice, n8n, celestia) without
 * requiring a row in the `skills` table.
 */

import { eq, and, desc } from "drizzle-orm";
import { getDb } from "@/db";
import { skills } from "@/db/schema";
import type { Skill } from "@/types/skill_types";

/** Bump when any built-in adapter's behaviour changes. Feeds the intent hash. */
export const BUILTIN_ADAPTERS_VERSION = "1.0.0";

export type BuiltinAdapterName =
  | "firecrawl-deep-scrape"
  | "libreoffice-calc-export"
  | "n8n-trigger"
  | "celestia-anchor"
  | "opus-reasoning";

export interface BuiltinAdapter {
  name: BuiltinAdapterName;
  /** IPC channel that backs this adapter (for documentation / audit). */
  channel: string;
  /** Stable description; included in the manifest hash. */
  description: string;
}

export const BUILTIN_ADAPTERS: Record<BuiltinAdapterName, BuiltinAdapter> = {
  "firecrawl-deep-scrape": {
    name: "firecrawl-deep-scrape",
    channel: "scraper:quick-scrape",
    description: "Local Puppeteer/Firecrawl deep scrape of a target URL with configurable depth.",
  },
  "libreoffice-calc-export": {
    name: "libreoffice-calc-export",
    channel: "libreoffice:export",
    description: "Headless LibreOffice export of structured data to xlsx/csv/pdf.",
  },
  "n8n-trigger": {
    name: "n8n-trigger",
    channel: "services:start",
    description: "Trigger an n8n workflow via local webhook.",
  },
  "celestia-anchor": {
    name: "celestia-anchor",
    channel: "celestia:blob:submit",
    description: "Anchor a content hash to the Celestia DA layer.",
  },
  "opus-reasoning": {
    name: "opus-reasoning",
    channel: "chat:llm",
    description: "Frontier-model reasoning step.",
  },
};

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
    return { kind: "builtin", adapter: BUILTIN_ADAPTERS[name as BuiltinAdapterName] };
  }

  throw new Error(
    `Blueprint skill "${name}" not found in skills table or built-in adapter map. ` +
      `Built-ins: ${Object.keys(BUILTIN_ADAPTERS).join(", ")}.`,
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
