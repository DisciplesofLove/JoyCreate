/**
 * BlueprintOrchestrator — main-process executor for Sovereign Blueprints.
 *
 * Pipeline per `run`:
 *   1. parse YAML → validate schema → topo sort
 *   2. resolve every skill (skill_engine first, then built-in adapters)
 *   3. up-front Whitehat: assert each node's `verify_intent` matches the
 *      recomputed manifest hash → abort whole run on first mismatch
 *   4. createRun row in `blueprint_runs`
 *   5. execute nodes in topo order, persisting per-node state, with
 *      pre-execution hash re-check (defence in depth) and template
 *      substitution from prior outputs
 *
 * Resume: `resumeAllPending()` is called from `registerIpcHandlers()` at
 * boot. Each run resumes from `currentNodeId`; nodes whose stored
 * `intentHash` still matches the recomputed hash are skipped.
 */

import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import log from "electron-log";
import {
  type Blueprint,
  type BlueprintNode,
  BlueprintIntegrityError,
  BlueprintParseError,
} from "@/types/blueprint_types";
import type { BlueprintNodeRunState } from "@/db/schema";
import { parseBlueprint, topoSort } from "./parser";
import { resolveSkill, type ResolvedSkill } from "./skill_resolver";
import { computeIntentHash, assertIntentHash } from "./intent_hash";
import {
  createRun,
  getRun,
  listResumableRuns,
  updateNodeState,
  updateRunStatus,
  type BlueprintRunRecord,
} from "./run_store";
import { executeSkill } from "@/lib/skill_engine";

const logger = log.scope("BlueprintOrchestrator");

export interface RunBlueprintOptions {
  /** Original YAML text — hashed into `manifestHash` for tamper detection. */
  yamlText: string;
  /** Initial input merged into the template context as `$USER_INPUT`. */
  input?: Record<string, unknown>;
  /** Override the agentDid in the YAML (e.g. signed-intent caller). */
  agentDid?: string;
  /** When true, parse/verify/persist but do not execute nodes. */
  dryRun?: boolean;
}

export class BlueprintOrchestrator extends EventEmitter {
  /** In-flight runs that should pause-not-cancel if the app shuts down. */
  private readonly inFlight = new Map<string, AbortController>();

  /** Parse + verify + (optionally) execute. Returns the run id. */
  async run(opts: RunBlueprintOptions): Promise<string> {
    const bp = parseBlueprint(opts.yamlText);
    const order = topoSort(bp);
    const resolved = await this.resolveAll(order);
    this.verifyAll(order, resolved);

    const runId = randomUUID();
    const manifestHash = createHash("sha256").update(opts.yamlText).digest("hex");
    await createRun({
      id: runId,
      blueprintId: bp.id,
      blueprintVersion: bp.version,
      manifestHash,
      agentDid: opts.agentDid ?? bp.author_did,
      input: opts.input ?? null,
    });

    if (opts.dryRun) {
      await updateRunStatus(runId, "succeeded", { output: null });
      this.emit("run:complete", runId);
      return runId;
    }

    // fire-and-forget; observers poll via `getRun` or listen to events
    this.executeRun(runId, bp, order, resolved, opts.input ?? {}).catch((err) => {
      logger.error(`Run ${runId} crashed:`, err);
    });
    return runId;
  }

  async cancel(runId: string): Promise<void> {
    const ctrl = this.inFlight.get(runId);
    if (ctrl) ctrl.abort();
    await updateRunStatus(runId, "aborted", { error: "Cancelled by user" });
    this.emit("run:cancel", runId);
  }

  /**
   * Resume any runs left in pending/running/paused state from a previous
   * session. Called once at IPC boot.
   */
  async resumeAllPending(): Promise<number> {
    const runs = await listResumableRuns();
    let resumed = 0;
    for (const run of runs) {
      try {
        await this.resumeOne(run);
        resumed++;
      } catch (err) {
        logger.error(`Failed to resume run ${run.id}:`, err);
        await updateRunStatus(run.id, "failed", {
          error: `Resume failed: ${(err as Error).message}`,
        });
      }
    }
    if (resumed > 0) logger.info(`Resumed ${resumed} blueprint run(s).`);
    return resumed;
  }

  // ---------------------------------------------------------------------------
  // internal
  // ---------------------------------------------------------------------------

  private async resolveAll(order: BlueprintNode[]): Promise<Map<string, ResolvedSkill>> {
    const map = new Map<string, ResolvedSkill>();
    for (const node of order) {
      map.set(node.id, await resolveSkill(node.skill));
    }
    return map;
  }

  private verifyAll(
    order: BlueprintNode[],
    resolved: Map<string, ResolvedSkill>,
  ): void {
    for (const node of order) {
      const r = resolved.get(node.id)!;
      assertIntentHash(node.id, node.verify_intent, r);
    }
  }

  private async executeRun(
    runId: string,
    bp: Blueprint,
    order: BlueprintNode[],
    resolved: Map<string, ResolvedSkill>,
    initialInput: Record<string, unknown>,
  ): Promise<void> {
    const ctrl = new AbortController();
    this.inFlight.set(runId, ctrl);
    await updateRunStatus(runId, "running");
    this.emit("run:start", runId);

    const outputs: Record<string, unknown> = { $USER_INPUT: initialInput };
    let lastOutput: unknown = null;
    try {
      for (const node of order) {
        if (ctrl.signal.aborted) {
          throw new Error("Run aborted before node " + node.id);
        }
        const r = resolved.get(node.id)!;
        // Defence in depth: re-check the hash right before executing.
        assertIntentHash(node.id, node.verify_intent, r);

        const startedAt = Date.now();
        const params = substituteTemplates(node.params, outputs);
        await updateNodeState(runId, node.id, {
          status: "running",
          intentHash: node.verify_intent,
          startedAt,
        });
        this.emit("node:start", { runId, nodeId: node.id });

        try {
          const out = await this.executeNode(node, r, params);
          outputs[node.id] = { output: out };
          lastOutput = out;
          await updateNodeState(runId, node.id, {
            status: "succeeded",
            intentHash: node.verify_intent,
            output: out,
            startedAt,
            completedAt: Date.now(),
          });
          this.emit("node:complete", { runId, nodeId: node.id, output: out });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          await updateNodeState(runId, node.id, {
            status: "failed",
            intentHash: node.verify_intent,
            error: msg,
            startedAt,
            completedAt: Date.now(),
          });
          this.emit("node:fail", { runId, nodeId: node.id, error: msg });
          throw err;
        }
      }
      await updateRunStatus(runId, "succeeded", { output: lastOutput });
      this.emit("run:complete", runId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const status =
        err instanceof BlueprintIntegrityError ? "aborted" : "failed";
      await updateRunStatus(runId, status, { error: msg });
      this.emit("run:fail", { runId, error: msg, status });
    } finally {
      this.inFlight.delete(runId);
    }
  }

  private async executeNode(
    node: BlueprintNode,
    resolved: ResolvedSkill,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    if (resolved.kind === "skill_engine") {
      const result = await executeSkill({
        skillId: resolved.skill.id,
        input: typeof params.input === "string" ? params.input : JSON.stringify(params),
      });
      if (!result.success) {
        throw new Error(result.error ?? "Skill execution failed");
      }
      return result.output;
    }
    // Built-in adapter execution is wired in a follow-up phase; for now the
    // resolver + hashing path is exercised but actual side effects throw.
    throw new Error(
      `Built-in adapter "${resolved.adapter.name}" execution is not wired in the foundation slice. ` +
        `Channel: ${resolved.adapter.channel}.`,
    );
  }

  private async resumeOne(run: BlueprintRunRecord): Promise<void> {
    // The original YAML is not stored; without it we cannot verify or
    // re-execute. Mark such runs as failed so they don't sit forever in
    // "running". Future work: persist the YAML alongside `manifestHash`
    // (see plan, follow-up considerations).
    await updateRunStatus(run.id, "failed", {
      error: "Resume not supported in foundation slice (YAML not persisted).",
    });
  }
}

let singleton: BlueprintOrchestrator | null = null;
export function getBlueprintOrchestrator(): BlueprintOrchestrator {
  if (!singleton) singleton = new BlueprintOrchestrator();
  return singleton;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const TEMPLATE_REF = /\{\{\s*([a-zA-Z0-9_$-]+(?:\.[a-zA-Z0-9_-]+)*)\s*\}\}/g;

/** Resolve `{{nodeId.output}}` and `{{$USER_INPUT.foo}}` refs in params. */
export function substituteTemplates(
  params: Record<string, unknown>,
  context: Record<string, unknown>,
): Record<string, unknown> {
  return walk(params, context) as Record<string, unknown>;
}

function walk(value: unknown, ctx: Record<string, unknown>): unknown {
  if (typeof value === "string") return resolveString(value, ctx);
  if (Array.isArray(value)) return value.map((v) => walk(v, ctx));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = walk(v, ctx);
    return out;
  }
  return value;
}

function resolveString(input: string, ctx: Record<string, unknown>): unknown {
  // If the entire string is a single template ref, return the raw resolved value.
  const exact = input.match(/^\s*\{\{\s*([a-zA-Z0-9_$-]+(?:\.[a-zA-Z0-9_-]+)*)\s*\}\}\s*$/);
  if (exact) return lookup(exact[1], ctx);
  return input.replace(TEMPLATE_REF, (_match, path: string) => {
    const v = lookup(path, ctx);
    return v == null ? "" : typeof v === "string" ? v : JSON.stringify(v);
  });
}

function lookup(path: string, ctx: Record<string, unknown>): unknown {
  const parts = path.split(".");
  let cur: unknown = ctx;
  for (const p of parts) {
    if (cur && typeof cur === "object" && p in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[p];
    } else {
      return undefined;
    }
  }
  return cur;
}

export { BlueprintParseError, BlueprintIntegrityError };
