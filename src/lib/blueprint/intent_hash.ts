/**
 * Whitehat intent hash — deterministic SHA-256 over a resolved skill's
 * canonical manifest. Recomputed at runtime and compared against the
 * Blueprint node's `verify_intent`. Mismatch => `BlueprintIntegrityError`.
 *
 * For `skill_engine` skills the manifest pins:
 *   id, name, version, type, implementationType, implementationCode,
 *   inputSchema, outputSchema.
 *
 * For built-in adapters the manifest pins:
 *   adapter name, channel, description, BUILTIN_ADAPTERS_VERSION.
 */

import { createHash } from "node:crypto";
import {
  type ResolvedSkill,
  BUILTIN_ADAPTERS_VERSION,
} from "./skill_resolver";
import { BlueprintIntegrityError } from "@/types/blueprint_types";

/** Recursively sort object keys → deterministic JSON serialization. */
function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(value as Record<string, unknown>).sort()) {
    out[k] = canonicalize((value as Record<string, unknown>)[k]);
  }
  return out;
}

export function canonicalManifest(resolved: ResolvedSkill): Record<string, unknown> {
  if (resolved.kind === "skill_engine") {
    const s = resolved.skill;
    return {
      kind: "skill_engine",
      name: s.name,
      version: s.version,
      type: s.type,
      implementationType: s.implementationType,
      implementationCode: s.implementationCode,
      inputSchema: s.inputSchema,
      outputSchema: s.outputSchema,
    };
  }
  return {
    kind: "builtin",
    name: resolved.adapter.name,
    channel: resolved.adapter.channel,
    description: resolved.adapter.description,
    adaptersVersion: BUILTIN_ADAPTERS_VERSION,
  };
}

/** Returns lowercase hex SHA-256 (64 chars). */
export function computeIntentHash(resolved: ResolvedSkill): string {
  const json = JSON.stringify(canonicalize(canonicalManifest(resolved)));
  return createHash("sha256").update(json).digest("hex");
}

/**
 * Throws `BlueprintIntegrityError` if the recomputed hash does not match
 * `expected`. Both are compared lowercase.
 */
export function assertIntentHash(
  nodeId: string,
  expected: string,
  resolved: ResolvedSkill,
): void {
  const actual = computeIntentHash(resolved);
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new BlueprintIntegrityError(
      `Whitehat verification failed for node "${nodeId}": skill manifest hash mismatch ` +
        `(expected ${expected.slice(0, 12)}..., got ${actual.slice(0, 12)}...). ` +
        `The skill code or schema changed since this Blueprint was signed.`,
      nodeId,
      expected,
      actual,
    );
  }
}
