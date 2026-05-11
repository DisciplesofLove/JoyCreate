/**
 * Blueprint YAML parser + topological sort.
 *
 * Produces a validated `Blueprint` from raw YAML. All node ids are
 * unique; `depends_on` (explicit or inferred from `{{ref}}` template
 * tags) form a DAG with no cycles.
 */

import { parse as parseYaml } from "yaml";
import { z } from "zod";
import {
  type Blueprint,
  type BlueprintNode,
  BlueprintParseError,
} from "@/types/blueprint_types";

const blueprintNodeSchema = z.object({
  id: z.string().min(1),
  skill: z.string().min(1),
  params: z.record(z.unknown()).default({}),
  verify_intent: z.string().regex(/^[0-9a-f]{64}$/i, "verify_intent must be 64-char SHA-256 hex"),
  depends_on: z.array(z.string()).optional(),
});

const blueprintOutcomeSchema = z.object({
  mint_as: z.string().min(1),
  supply: z.number().int().positive().optional(),
  royalty: z.string().optional(),
});

const blueprintSchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  author_did: z.string().regex(/^did:[a-z0-9]+:[A-Za-z0-9._-]+$/i, "author_did must be a DID"),
  whitehat_profile: z.string().optional(),
  nodes: z.array(blueprintNodeSchema).min(1),
  outcomes: z.array(blueprintOutcomeSchema).optional(),
});

const TEMPLATE_REF = /\{\{\s*([a-zA-Z0-9_-]+)\.[a-zA-Z0-9_.-]+\s*\}\}/g;

/**
 * Parse a YAML string into a validated Blueprint.
 * Throws `BlueprintParseError` on any failure (YAML syntax, schema,
 * duplicate node ids, unknown deps, cycles).
 */
export function parseBlueprint(yamlText: string): Blueprint {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (err) {
    throw new BlueprintParseError(`Invalid YAML: ${(err as Error).message}`, err);
  }

  const result = blueprintSchema.safeParse(raw);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new BlueprintParseError(
      `Blueprint schema validation failed at "${issue.path.join(".")}": ${issue.message}`,
      result.error,
    );
  }

  const bp = result.data as Blueprint;
  validateGraph(bp);
  return bp;
}

/**
 * Compute the topologically sorted execution order of nodes.
 * Throws `BlueprintParseError` on cycles or unknown dep refs.
 */
export function topoSort(bp: Blueprint): BlueprintNode[] {
  const nodesById = new Map(bp.nodes.map((n) => [n.id, n]));
  const deps = computeDeps(bp);

  const inDegree = new Map<string, number>();
  for (const id of nodesById.keys()) inDegree.set(id, 0);
  for (const [, parents] of deps) {
    for (const _ of parents) {
      // child counts deps; we count incoming edges per node
    }
  }
  // Recompute properly: inDegree[child] = parents.length
  for (const [child, parents] of deps) {
    inDegree.set(child, parents.size);
  }

  const queue: string[] = [];
  for (const [id, deg] of inDegree) if (deg === 0) queue.push(id);

  const order: BlueprintNode[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    order.push(nodesById.get(id)!);
    // any node that depends on `id` loses one in-degree
    for (const [child, parents] of deps) {
      if (parents.has(id)) {
        const next = (inDegree.get(child) ?? 0) - 1;
        inDegree.set(child, next);
        if (next === 0) queue.push(child);
      }
    }
  }

  if (order.length !== bp.nodes.length) {
    throw new BlueprintParseError(
      `Blueprint has a cycle: only ${order.length}/${bp.nodes.length} nodes are reachable`,
    );
  }
  return order;
}

function validateGraph(bp: Blueprint): void {
  const ids = new Set<string>();
  for (const n of bp.nodes) {
    if (ids.has(n.id)) {
      throw new BlueprintParseError(`Duplicate node id "${n.id}"`);
    }
    ids.add(n.id);
  }

  const deps = computeDeps(bp);
  for (const [child, parents] of deps) {
    for (const p of parents) {
      if (!ids.has(p)) {
        throw new BlueprintParseError(
          `Node "${child}" depends on unknown node "${p}"`,
        );
      }
      if (p === child) {
        throw new BlueprintParseError(`Node "${child}" depends on itself`);
      }
    }
  }

  // run topo sort to detect cycles
  topoSort(bp);
}

/** Returns Map<childId, Set<parentId>>. */
export function computeDeps(bp: Blueprint): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const node of bp.nodes) {
    const deps = new Set<string>(node.depends_on ?? []);
    // infer additional deps from `{{otherNode.field}}` template tags in params
    for (const ref of extractTemplateRefs(node.params)) {
      if (ref !== node.id) deps.add(ref);
    }
    map.set(node.id, deps);
  }
  return map;
}

function extractTemplateRefs(value: unknown, out: Set<string> = new Set()): Set<string> {
  if (typeof value === "string") {
    let m: RegExpExecArray | null;
    TEMPLATE_REF.lastIndex = 0;
    while ((m = TEMPLATE_REF.exec(value)) !== null) {
      out.add(m[1]);
    }
    return out;
  }
  if (Array.isArray(value)) {
    for (const v of value) extractTemplateRefs(v, out);
    return out;
  }
  if (value && typeof value === "object") {
    for (const v of Object.values(value)) extractTemplateRefs(v, out);
    return out;
  }
  return out;
}
