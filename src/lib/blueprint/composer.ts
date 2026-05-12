/**
 * Blueprint NLP composer.
 *
 * Takes a natural-language intent and produces a fully-validated
 * Blueprint (YAML + parsed object). The LLM proposes the plan; this
 * module is responsible for everything that requires deterministic
 * output: skill resolution, intent-hash computation, schema validation,
 * and YAML serialization.
 *
 * Pipeline:
 *   1. Build a system prompt enumerating built-in adapters + DB skills.
 *   2. Call the LLM (in-process via getModelClient) to get a JSON plan
 *      shaped {id, version, author_did, nodes:[{id, skill, params,
 *      depends_on?}], outcomes?}.
 *   3. For each node: resolve the skill, recompute the intent hash,
 *      and patch it onto the node.
 *   4. Serialize to YAML, parse it back through `parseBlueprint` so the
 *      caller gets a guaranteed-valid Blueprint.
 */

import { stringify as yamlStringify } from "yaml";
import { generateText } from "ai";
import log from "electron-log";

import { getDb } from "@/db";
import { skills } from "@/db/schema";
import { eq, desc } from "drizzle-orm";
import { getModelClient } from "@/ipc/utils/get_model_client";
import { readSettings } from "@/main/settings";
import type { LargeLanguageModel } from "@/lib/schemas";

import { type Blueprint } from "@/types/blueprint_types";
import { BUILTIN_ADAPTERS, listBuiltinAdapters, resolveSkill } from "./skill_resolver";
import { computeIntentHash } from "./intent_hash";
import { parseBlueprint } from "./parser";

const logger = log.scope("blueprint:composer");

export interface ComposeBlueprintOptions {
  /** Natural-language description of the desired workflow. */
  intent: string;
  /** Optional DID to attribute the blueprint to. Defaults to "did:joy:local". */
  authorDid?: string;
  /** Override LLM model. */
  modelId?: string;
  /** Add hints (e.g. preferred adapters, target marketplace). */
  hints?: string;
}

export interface ComposeBlueprintResult {
  yaml: string;
  blueprint: Blueprint;
  /** Raw LLM output (debugging). */
  rawPlan: string;
}

interface RawPlanNode {
  id: string;
  skill: string;
  params?: Record<string, unknown>;
  depends_on?: string[];
}
interface RawPlan {
  id?: string;
  version?: string;
  author_did?: string;
  whitehat_profile?: string;
  nodes: RawPlanNode[];
  outcomes?: Array<{ mint_as: string; supply?: number; royalty?: string }>;
}

const DEFAULT_AUTHOR_DID = "did:joy:local";

const SYSTEM_PROMPT = `You are the JoyCreate Sovereign Blueprint composer.

You translate a user's natural-language intent into a directed acyclic
graph (DAG) of skill invocations. Each node calls one "skill" — either a
registered user skill (referenced by its name) or a built-in adapter from
the catalog below.

OUTPUT FORMAT — return ONLY a single JSON object inside one fenced
\`\`\`json block. No prose. The shape MUST be:

{
  "id": "<slug>",                 // e.g. "sovereign-researcher-hydrogen"
  "version": "1.0.0",
  "author_did": "did:joy:local",
  "nodes": [
    {
      "id": "<unique-step-id>",   // referenced via {{stepId.output}} downstream
      "skill": "<adapter or skill name>",
      "params": { ... },          // free-form, may use {{otherStep.output.foo}}
      "depends_on": ["..."]       // optional; deps are auto-inferred from {{refs}}
    }
  ],
  "outcomes": [                   // optional — if the user wants a marketplace mint
    { "mint_as": "drop-edition-erc1155", "supply": 100, "royalty": "5%" }
  ]
}

REFERENCING UPSTREAM OUTPUTS:
  Use double-brace templates: {{stepId.output}} or {{stepId.output.field}}.
  The initial user input is available as {{$USER_INPUT}} (or .field).

DO NOT include "verify_intent" — it is computed deterministically by the
composer after you respond.

PRINCIPLES:
  • Prefer the smallest correct DAG. 2-5 nodes is the sweet spot.
  • Use "opus-reasoning" only when no adapter fits (drafting prose, summarising).
  • Use "firecrawl-deep-scrape" for credentialed deep-web data, "web-fetch"
    for plain URLs, "web-search" for discovery.
  • Use "publish-workflow" / "publish-asset" only when the user explicitly
    wants the result on the marketplace.
  • Use "celestia-anchor" / "agent-provenance-attest" when the user asks
    for verifiable / attested data.
  • Always wire LATER nodes to EARLIER nodes via {{ref}} — never call
    nodes out of order.`;

export async function composeBlueprint(
  opts: ComposeBlueprintOptions,
): Promise<ComposeBlueprintResult> {
  if (!opts.intent || !opts.intent.trim()) {
    throw new Error("composeBlueprint requires a non-empty intent.");
  }

  const catalog = await renderCatalog();
  const userPrompt = [
    `## Available adapters (built-in)\n${catalog.adapters}`,
    catalog.skills ? `## Available user skills\n${catalog.skills}` : "",
    opts.hints ? `## Hints\n${opts.hints}` : "",
    `## User intent\n${opts.intent.trim()}`,
    `\nReturn the JSON plan now.`,
  ]
    .filter(Boolean)
    .join("\n\n");

  const settings = readSettings();
  const selectedRaw = (
    settings as { selectedChatModel?: { provider?: string; name?: string } }
  ).selectedChatModel;
  const model: LargeLanguageModel = {
    provider: (selectedRaw?.provider ?? "auto") as LargeLanguageModel["provider"],
    name: opts.modelId ?? selectedRaw?.name ?? "claude-sonnet-4-5",
  };
  const { modelClient } = await getModelClient(model, settings);

  const result = await generateText({
    model: modelClient.model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ] as unknown as Parameters<typeof generateText>[0]["messages"],
    maxRetries: 1,
    temperature: 0.2,
  });

  const rawPlan = (result as { text?: string }).text ?? "";
  const plan = extractJsonPlan(rawPlan);

  // Patch in defaults + verify_intent per node, then serialize.
  const yaml = await planToYaml(plan, opts.authorDid ?? DEFAULT_AUTHOR_DID);
  const blueprint = parseBlueprint(yaml); // throws on any structural issue
  logger.info(
    `composed blueprint "${blueprint.id}" with ${blueprint.nodes.length} nodes`,
  );
  return { yaml, blueprint, rawPlan };
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

async function renderCatalog(): Promise<{ adapters: string; skills: string }> {
  const adapters = listBuiltinAdapters()
    .map((a) => `- **${a.name}** — ${a.description}${a.paramDocs ? `\n    params: ${a.paramDocs}` : ""}`)
    .join("\n");

  const db = getDb();
  const rows = await db
    .select({
      name: skills.name,
      description: skills.description,
      version: skills.version,
    })
    .from(skills)
    .where(eq(skills.enabled, true))
    .orderBy(desc(skills.updatedAt))
    .limit(40);
  const skillsList = rows.length === 0
    ? ""
    : rows.map((r) => `- **${r.name}** (v${r.version ?? "?"}) — ${r.description ?? ""}`).join("\n");
  return { adapters, skills: skillsList };
}

function extractJsonPlan(text: string): RawPlan {
  // Try fenced ```json block first, then bare JSON.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : text).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (err) {
    throw new Error(
      `Composer LLM did not return valid JSON. First 200 chars: ${candidate.slice(0, 200)}`,
    );
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Composer plan is not a JSON object.");
  }
  const p = parsed as Partial<RawPlan>;
  if (!Array.isArray(p.nodes) || p.nodes.length === 0) {
    throw new Error("Composer plan must have a non-empty `nodes` array.");
  }
  return {
    id: typeof p.id === "string" ? p.id : "blueprint-" + Math.random().toString(36).slice(2, 8),
    version: typeof p.version === "string" ? p.version : "1.0.0",
    author_did: typeof p.author_did === "string" ? p.author_did : undefined,
    whitehat_profile: typeof p.whitehat_profile === "string" ? p.whitehat_profile : undefined,
    nodes: p.nodes,
    outcomes: Array.isArray(p.outcomes) ? p.outcomes : undefined,
  };
}

async function planToYaml(plan: RawPlan, authorDid: string): Promise<string> {
  const nodesOut: Array<Record<string, unknown>> = [];
  for (const n of plan.nodes) {
    if (!n.id || typeof n.id !== "string") {
      throw new Error("Composer plan node missing string `id`.");
    }
    if (!n.skill || typeof n.skill !== "string") {
      throw new Error(`Composer plan node "${n.id}" missing string \`skill\`.`);
    }
    const resolved = await resolveSkill(n.skill);
    const verify_intent = computeIntentHash(resolved);
    const params = (n.params && typeof n.params === "object") ? n.params : {};
    nodesOut.push({
      id: n.id,
      skill: n.skill,
      params,
      verify_intent,
      ...(n.depends_on && n.depends_on.length > 0 ? { depends_on: n.depends_on } : {}),
    });
  }

  const doc: Record<string, unknown> = {
    id: plan.id,
    version: plan.version,
    author_did: plan.author_did ?? authorDid,
    ...(plan.whitehat_profile ? { whitehat_profile: plan.whitehat_profile } : {}),
    nodes: nodesOut,
    ...(plan.outcomes && plan.outcomes.length > 0 ? { outcomes: plan.outcomes } : {}),
  };

  return yamlStringify(doc, { lineWidth: 0 });
}

/**
 * Convenience: validate a YAML blueprint without executing it.
 * Returns the parsed Blueprint or throws a structured error.
 */
export function validateBlueprintYaml(yamlText: string): Blueprint {
  return parseBlueprint(yamlText);
}

/**
 * Convenience: refresh the verify_intent hashes in an existing YAML by
 * re-resolving every skill. Useful after a built-in adapter version bump.
 */
export async function rehashBlueprintYaml(yamlText: string): Promise<string> {
  const bp = parseBlueprint(yamlText);
  const nodesOut: Array<Record<string, unknown>> = [];
  for (const n of bp.nodes) {
    const resolved = await resolveSkill(n.skill);
    nodesOut.push({
      id: n.id,
      skill: n.skill,
      params: n.params,
      verify_intent: computeIntentHash(resolved),
      ...(n.depends_on && n.depends_on.length > 0 ? { depends_on: n.depends_on } : {}),
    });
  }
  const doc: Record<string, unknown> = {
    id: bp.id,
    version: bp.version,
    author_did: bp.author_did,
    ...(bp.whitehat_profile ? { whitehat_profile: bp.whitehat_profile } : {}),
    nodes: nodesOut,
    ...(bp.outcomes && bp.outcomes.length > 0 ? { outcomes: bp.outcomes } : {}),
  };
  return yamlStringify(doc, { lineWidth: 0 });
}

// re-export for convenience
export { BUILTIN_ADAPTERS, listBuiltinAdapters };
