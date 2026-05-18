/**
 * Domain Event Bus — typed in-process pub/sub on Node EventEmitter.
 *
 * Every publish is forwarded to {@link recordDomainEvent} so subscribers
 * (notifications, on-chain listeners, future analytics) can replay the
 * exact stream at boot. Subscriber errors are isolated: one failing
 * handler never blocks the others, and failures are logged.
 *
 * Channel naming: lowercase, dot-separated (`asset.published`,
 * `agent.invoked`). Add new types to {@link DomainEventMap} when you need
 * them — that union is the contract for the whole app.
 */

import { EventEmitter } from "node:events";
import log from "electron-log";

import { recordDomainEvent } from "./event_log";

const logger = log.scope("domain_event_bus");

// ── Event payload contracts ──────────────────────────────────────────────

export interface AssetPublishedPayload {
  assetType: "agent" | "workflow" | "dataset" | "image" | "video" | "model" | "blueprint" | "document";
  assetRef: string;
  /** Human display name. */
  name: string;
  /** Wallet that signed the publish, lowercased. */
  publisherAddress: string;
  /** ERC-1155 token id from the DropERC1155, if known. */
  tokenId?: string;
  contractAddress?: string;
  /** Listing price as USDC string (6 decimals). */
  priceUsdc?: string;
  txHash?: string;
}

export interface AssetClaimedPayload {
  contractAddress: string;
  tokenId: string;
  buyerAddress: string;
  amountUnits: string;
  totalPriceUsdc?: string;
  txHash: string;
  blockNumber: number;
}

export interface AssetRoyaltyReceivedPayload {
  contractAddress: string;
  tokenId: string;
  recipient: string;
  amountUsdc: string;
  txHash: string;
  blockNumber: number;
}

export interface AgentInvokedPayload {
  agentRef: string;
  agentName: string;
  /** "rental" if an off-chain renter triggered, "owner" otherwise. */
  callerKind: "rental" | "owner" | "system";
  callerAddress?: string;
  /** Raw cost units billed to the caller (USDC string). */
  amountUsdc?: string;
}

export interface ComputeJobCompletedPayload {
  jobId: string;
  status: "succeeded" | "failed";
  durationMs: number;
  workerAddress?: string;
  /** Provider-reported cost in USDC string. */
  costUsdc?: string;
}

export interface ReputationDeltaPayload {
  subjectAddress: string;
  delta: number;
  reason: string;
}

export interface GeniusCoreInitializedPayload {
  executionProvider: string;
  vramBudgetGb: number;
  baseModelId: string;
}

export interface GeniusCoreBaseLoadedPayload {
  baseModelId: string;
  /** Bytes resident in VRAM / accelerator memory for the base layer. */
  residentBytes: number;
  /** Milliseconds to first usable token after load. */
  loadDurationMs: number;
}

export interface GeniusCoreContextSlotLoadedPayload {
  projectId: string;
  /** IPLD CID of the slot, when persisted. Omitted on fresh slots. */
  slotCid?: string;
  loadDurationMs: number;
}

export interface GeniusCoreInferenceCompletedPayload {
  projectId?: string;
  modelId: string;
  executionProvider: string;
  tokensIn: number;
  tokensOut: number;
  durationMs: number;
  /** True when shards were streamed live from P2P peers during this step. */
  usedShardStream: boolean;
}

export interface GeniusCoreDistillationCompletedPayload {
  projectId: string;
  adapterId: string;
  method: "lora" | "qlora";
  sampleCount: number;
  finalLoss: number;
  durationMs: number;
  /**
   * Hex-encoded SHA-256 over the adapter weight bytes. Empty string when
   * the trainer did not produce raw bytes (eg. delta-only updates).
   * Consumers can use this to independently verify peer-published
   * adapters before merging or pinning.
   */
  adapterHash: string;
}

/**
 * Streaming per-step training progress emitted *during* a distillation
 * run. UI subscribers can render a live loss curve / progress bar. The
 * scheduler generates a `runId` per training invocation so multiple
 * concurrent runs (different projects) can be demultiplexed. Best-effort
 * — listeners must NOT block the trainer.
 */
export interface GeniusCoreDistillationProgressPayload {
  projectId: string;
  /** Unique id for this training invocation (stable across the run). */
  runId: string;
  /** 1-based step index. */
  step: number;
  /** Total planned steps when known; null when streaming open-ended. */
  totalSteps: number | null;
  /** Training loss at this step, when available. */
  loss: number | null;
  /** Wall-clock timestamp of the progress sample. */
  atMs: number;
}

export interface GeniusCoreAdapterPublishedPayload {
  adapterId: string;
  projectId: string;
  /** Encrypted-at-rest CID of the adapter blob (Lit-encrypted before pinning). */
  ciphertextCid: string;
  /** Stylus DropEdition mint tx hash, when on-chain publish succeeded. */
  mintTxHash?: string;
  /** Celestia anchor tx, when DA submission succeeded. */
  celestiaTxHash?: string;
}

export interface GeniusCoreAdapterRolledBackPayload {
  projectId: string;
  /** Adapter id that was rejected. */
  adapterId: string;
  /** Score of the rejected adapter, in [0, 1]. */
  score: number;
  /** Score of the previous applied adapter (baseline). */
  baselineScore: number;
  /** New head context slot CID after rollback; null if cleared. */
  revertedToCid: string | null;
}

export interface GeniusCoreAdapterAggregatedPayload {
  projectId: string;
  /** Number of peer candidates considered (after eval/ACL filtering). */
  candidatesUsed: number;
  /** Sum of (sampleCount / max(0.01, finalLoss)) across used candidates. */
  totalWeight: number;
  /** Adapter ids that contributed to the merge. */
  sourceAdapterIds: string[];
  /** New context slot CID created from the merged adapter, if persisted. */
  newSlotCid: string | null;
}

/**
 * Edit logger backpressure event — fired when the in-memory buffer
 * overflows and the oldest entries are dropped. The control panel
 * consumes this to surface a banner so users know they are losing
 * training signal (typically because the disk writer is stalled).
 */
export interface GeniusCoreEditLogDroppedPayload {
  /** Project id when all dropped entries shared one; null when mixed. */
  projectId: number | null;
  /** Entries dropped in this overflow event. */
  droppedCount: number;
  /** Running total dropped across the logger's lifetime. */
  totalDropped: number;
  /** Buffer-size cap at the moment of overflow. */
  bufferSize: number;
  /** Wall-clock timestamp of the overflow. */
  atMs: number;
}

/**
 * Emitted when a chat turn that originally targeted Genius Core was
 * routed to a capable fallback model because the turn required tool /
 * function calling. Lets the control panel surface "this turn was
 * answered by <fallback>" so the user knows their selection was
 * temporarily bypassed.
 */
export interface GeniusCoreToolFallbackInvokedPayload {
  /** Chat id the swap happened in. */
  chatId: number;
  /** App id, if known, for per-app aggregation. */
  appId: number | null;
  /** The base model id the user originally selected on Genius Core. */
  originalModel: string;
  /** Provider+model the turn was actually routed to. */
  fallbackProvider: string;
  fallbackModel: string;
  /** Wall-clock ms at the swap. */
  atMs: number;
}

export interface DomainEventMap {
  "asset.published": AssetPublishedPayload;
  "asset.claimed": AssetClaimedPayload;
  "asset.royalty.received": AssetRoyaltyReceivedPayload;
  "agent.invoked": AgentInvokedPayload;
  "compute.job.completed": ComputeJobCompletedPayload;
  "reputation.delta": ReputationDeltaPayload;
  "genius_core.initialized": GeniusCoreInitializedPayload;
  "genius_core.base.loaded": GeniusCoreBaseLoadedPayload;
  "genius_core.context_slot.loaded": GeniusCoreContextSlotLoadedPayload;
  "genius_core.inference.completed": GeniusCoreInferenceCompletedPayload;
  "genius_core.distillation.completed": GeniusCoreDistillationCompletedPayload;
  "genius_core.distillation.progress": GeniusCoreDistillationProgressPayload;
  "genius_core.adapter.published": GeniusCoreAdapterPublishedPayload;
  "genius_core.adapter.rolled_back": GeniusCoreAdapterRolledBackPayload;
  "genius_core.adapter.aggregated": GeniusCoreAdapterAggregatedPayload;
  "genius_core.edit_log.dropped": GeniusCoreEditLogDroppedPayload;
  "genius_core.tool_fallback.invoked": GeniusCoreToolFallbackInvokedPayload;
}

export type DomainEventType = keyof DomainEventMap;

export interface DomainEventEnvelope<T extends DomainEventType = DomainEventType> {
  /** Database row id (assigned after persist; 0 before persistence). */
  id: number;
  type: T;
  payload: DomainEventMap[T];
  occurredAt: Date;
  sourceTxHash?: string;
  sourceLogIndex?: number;
  version: number;
}

export type DomainEventListener<T extends DomainEventType> = (
  envelope: DomainEventEnvelope<T>,
) => void | Promise<void>;

// ── Singleton bus ────────────────────────────────────────────────────────

class DomainEventBus {
  private static instance: DomainEventBus | null = null;
  private readonly emitter = new EventEmitter();

  private constructor() {
    // 50 subscribers per channel is plenty; keeps Node from warning.
    this.emitter.setMaxListeners(50);
  }

  static getInstance(): DomainEventBus {
    if (!DomainEventBus.instance) {
      DomainEventBus.instance = new DomainEventBus();
    }
    return DomainEventBus.instance;
  }

  on<T extends DomainEventType>(type: T, listener: DomainEventListener<T>): () => void {
    const wrapped = async (envelope: DomainEventEnvelope<T>) => {
      try {
        await listener(envelope);
      } catch (err) {
        logger.error(`subscriber for ${type} threw`, err);
      }
    };
    this.emitter.on(type, wrapped);
    return () => this.emitter.off(type, wrapped);
  }

  /**
   * Publish an event. Persists to `domain_events` first, then fans out to
   * subscribers with the assigned id. Returns the persisted envelope so
   * callers can correlate (e.g. set notifications.sourceEventId).
   */
  async publish<T extends DomainEventType>(
    type: T,
    payload: DomainEventMap[T],
    opts: { sourceTxHash?: string; sourceLogIndex?: number; version?: number } = {},
  ): Promise<DomainEventEnvelope<T>> {
    const persisted = await recordDomainEvent(type, payload, opts);
    const envelope: DomainEventEnvelope<T> = {
      id: persisted.id,
      type,
      payload,
      occurredAt: persisted.occurredAt,
      sourceTxHash: opts.sourceTxHash,
      sourceLogIndex: opts.sourceLogIndex,
      version: opts.version ?? 1,
    };
    // Use setImmediate so subscriber errors never propagate into the publisher.
    setImmediate(() => this.emitter.emit(type, envelope));
    return envelope;
  }
}

export function getDomainEventBus(): DomainEventBus {
  return DomainEventBus.getInstance();
}
