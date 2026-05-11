/**
 * Whitehat MCP — invocation hash.
 *
 * Mirrors `src/lib/blueprint/intent_hash.ts`: deterministic SHA-256 over the
 * canonical {server, tool, args} manifest. The hash is the unit of approval
 * the user grants from the JoyCreate UI.
 */

import { createHash } from "node:crypto";

/** Recursively sort object keys → deterministic JSON. */
function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(value as Record<string, unknown>).sort()) {
    out[k] = canonicalize((value as Record<string, unknown>)[k]);
  }
  return out;
}

export interface McpInvocation {
  serverName: string;
  toolName: string;
  args: unknown;
}

/** Returns lowercase hex SHA-256 (64 chars). */
export function computeInvocationHash(inv: McpInvocation): string {
  const canonical = canonicalize({
    server: inv.serverName,
    tool: inv.toolName,
    args: inv.args ?? null,
  });
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}
