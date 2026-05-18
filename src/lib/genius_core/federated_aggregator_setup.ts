/**
 * Genius Core — Production wiring for the FederatedAggregator.
 *
 * This file is intentionally **thin**. The aggregator's logic lives in
 * {@link ./federated_aggregator} and is fully unit-tested with
 * deterministic doubles. The remaining work to make it run against real
 * peer infrastructure (Hypercore log reader for the "genius-core" scope,
 * IPLD/Helia adapter byte fetcher, Lit Protocol ACL gate, context-slot
 * applier for merged weights) belongs to Phase 9 — "P2P shard streaming".
 *
 * Returning `undefined` here is the explicit "not wired" signal. The
 * {@link DistillationScheduler} treats that as a no-op without warning
 * so the local pipeline keeps shipping while Phase 9 work is in flight.
 *
 * When Phase 9 lands, replace the body of {@link setupFederatedAggregator}
 * with concrete dependency wiring — no scheduler changes required.
 */

import log from "electron-log";
import type { FederatedAggregator } from "./federated_aggregator";

const logger = log.scope("genius_core.federated_aggregator.setup");

/**
 * Resolve the live FederatedAggregator if all required peer-layer
 * dependencies are available, otherwise `undefined`. Never throws — a
 * setup failure must not break the local distillation pipeline.
 */
export async function setupFederatedAggregator(): Promise<
  FederatedAggregator | undefined
> {
  // Phase 9 will populate this with real deps:
  //   - readPeerCandidates → HyperLogStore<GeniusCoreHyperEvent>(
  //       "genius-core", projectId).read({ start: lastSeq })
  //       then filter to type === "distill" from other peers.
  //   - aclGate → lit_relayer access-condition check on the candidate
  //       peer's pubkey vs. project's lease registry.
  //   - fetchAdapterWeights → Helia get(adapterCid) → Float32Array.
  //   - applyMergedAdapter → ContextSlotManager.updateSlot(...).
  //   - publishAggregated → DomainEventBus.publish(
  //       "genius_core.adapter.aggregated", payload).
  logger.debug("federated aggregator not yet wired (phase 9 work)");
  return undefined;
}
