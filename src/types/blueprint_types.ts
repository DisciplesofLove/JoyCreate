/**
 * Sovereign Blueprint types.
 *
 * A Blueprint is a YAML-defined Directed Acyclic Graph of skill invocations
 * with cryptographic intent hashes (Whitehat Protocol). Blueprints compile
 * down to the existing `WorkflowDefinition` JSON shape consumed by
 * `AgentOrchestratorEngine`. See `/memories/session/blueprint_engine_plan.md`.
 */

export interface BlueprintNode {
  /** Unique node id within the Blueprint (e.g. "research"). */
  id: string;
  /**
   * Skill name to execute. Resolved via `skill_resolver.ts` against
   * `skill_engine` first, then a built-in adapter map.
   */
  skill: string;
  /** Free-form params passed to the resolved skill. May contain `{{nodeId.output}}` template refs. */
  params: Record<string, unknown>;
  /**
   * SHA-256 hex of the resolved skill manifest (Whitehat Hash).
   * Verified BEFORE this node executes; mismatch aborts the run.
   */
  verify_intent: string;
  /**
   * Optional explicit dependency list. If omitted, deps are inferred from
   * `{{otherNodeId.*}}` template references inside `params`.
   */
  depends_on?: string[];
}

export interface BlueprintOutcome {
  /** Mint type (e.g. "drop-edition-erc1155"). Parsed but ignored in the Foundation slice. */
  mint_as: string;
  supply?: number;
  /** e.g. "5%" or "0.05". Stored verbatim. */
  royalty?: string;
}

export interface Blueprint {
  id: string;
  version: string;
  /** Author DID, e.g. "did:joy:abc123". */
  author_did: string;
  /** Whitehat profile name; matched against `neural_guard_policy` profiles in later phases. */
  whitehat_profile?: string;
  nodes: BlueprintNode[];
  outcomes?: BlueprintOutcome[];
}

/** Thrown when YAML parsing or schema validation fails. */
export class BlueprintParseError extends Error {
  override name = "BlueprintParseError";
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
  }
}

/** Thrown when the resolved skill manifest's hash does not match `verify_intent`. */
export class BlueprintIntegrityError extends Error {
  override name = "BlueprintIntegrityError";
  constructor(
    message: string,
    public readonly nodeId: string,
    public readonly expected: string,
    public readonly actual: string,
  ) {
    super(message);
  }
}
