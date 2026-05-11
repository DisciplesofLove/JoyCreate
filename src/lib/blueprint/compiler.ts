/**
 * Translate a `Blueprint` into the existing `WorkflowDefinition` JSON
 * shape consumed by `AgentOrchestratorEngine`. This is primarily used
 * for visualization (the future React Flow canvas) and to make Blueprint
 * runs interoperable with the existing workflow dashboard.
 *
 * Execution itself is performed by `BlueprintOrchestrator` (see
 * `orchestrator.ts`) which owns the verify-then-trust hook and SQLite
 * run state.
 */

import type {
  WorkflowDefinition,
  WorkflowNode,
  WorkflowEdge,
} from "@/types/agent_builder";
import type { Blueprint } from "@/types/blueprint_types";
import { computeDeps, topoSort } from "./parser";

export function compileBlueprint(bp: Blueprint): WorkflowDefinition {
  const order = topoSort(bp);
  const deps = computeDeps(bp);

  const nodes: WorkflowNode[] = order.map((n, idx) => ({
    id: n.id,
    type: "tool",
    name: n.skill,
    position: { x: idx * 220, y: 0 },
    config: {
      toolName: n.skill,
      // Stringify the param values so the existing `inputMapping` shape
      // (Record<string, string>) accepts them. Real execution uses the
      // raw `BlueprintNode.params` via `BlueprintOrchestrator`.
      inputMapping: serializeParams(n.params),
    },
  }));

  const edges: WorkflowEdge[] = [];
  for (const [child, parents] of deps) {
    for (const parent of parents) {
      edges.push({
        id: `${parent}->${child}`,
        sourceId: parent,
        targetId: child,
      });
    }
  }

  const entryNode = order.find((n) => (deps.get(n.id)?.size ?? 0) === 0);
  if (!entryNode) {
    // unreachable — topoSort would already have thrown on a cycle
    throw new Error("Blueprint compile failed: no entry node");
  }

  return {
    nodes,
    edges,
    entryNodeId: entryNode.id,
  };
}

function serializeParams(params: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) {
    out[k] = typeof v === "string" ? v : JSON.stringify(v);
  }
  return out;
}
