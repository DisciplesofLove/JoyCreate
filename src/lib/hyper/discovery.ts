/**
 * Topic / discovery-key derivation for the Hypercore peer layer.
 *
 * A "topic" in JoyCreate is a (scope, subjectId) pair, where:
 *   scope     = which subsystem this core belongs to ("provenance",
 *               "blueprint-runs", "agent-collab", …).
 *   subjectId = the per-subject identifier within that scope (e.g.
 *               agent DID, blueprint manifest hash, channel id).
 *
 * The Hyperswarm discovery key is the blake2b-256 hash of
 *   "joycreate:<scope>:<subjectId>"
 * which gives every (scope, subjectId) a deterministic 32-byte topic that
 * all peers can rendezvous on without prior coordination.
 */

import { createHash } from "node:crypto";

export type HyperScope =
  | "provenance"
  | "whitehat-anchor"
  | "ssi-anchor"
  | "openclaw-activity"
  | "vault-audit"
  | "jcn-audit"
  | "slash-records"
  | "blueprint-runs"
  | "blueprint-manifest"
  | "agent-collab"
  | "agent-collab-channels"
  | "agent-collab-tasks"
  | "model-registry"
  | "marketplace-listings"
  | "skills"
  | "datasets"
  | "content-blobs"
  | "sovereign-models"
  | "radicle-trust"
  | "federation"
  | "custom";

export interface TopicId {
  scope: HyperScope | string;
  subjectId: string;
  /** Canonical "scope:subjectId" string used as the registry map key. */
  key: string;
  /** Hex-encoded 32-byte discovery key for hyperswarm. */
  discoveryKeyHex: string;
}

/**
 * Compute a deterministic 32-byte topic key for a (scope, subjectId) pair.
 * blake2b is the canonical Holepunch hash but createHash("blake2b512") is
 * Node-builtin and we just take the first 32 bytes.
 */
export function topicKey(scope: string, subjectId: string): Buffer {
  if (!scope || typeof scope !== "string") {
    throw new Error("topicKey: scope must be a non-empty string");
  }
  if (typeof subjectId !== "string") {
    throw new Error("topicKey: subjectId must be a string");
  }
  const h = createHash("blake2b512");
  h.update(`joycreate:${scope}:${subjectId}`);
  return h.digest().subarray(0, 32);
}

export function makeTopicId(scope: string, subjectId: string): TopicId {
  const buf = topicKey(scope, subjectId);
  return {
    scope,
    subjectId,
    key: `${scope}:${subjectId}`,
    discoveryKeyHex: buf.toString("hex"),
  };
}

/**
 * Stable corestore "name" for a (scope, subjectId) pair. Corestore derives
 * its own keypair from this name + the corestore's primary key, so the same
 * (scope, subjectId) on the same device always produces the same writable
 * core.
 */
export function corestoreName(scope: string, subjectId: string): string {
  return `joycreate/${scope}/${subjectId}`;
}
