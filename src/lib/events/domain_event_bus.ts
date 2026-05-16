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

export interface DomainEventMap {
  "asset.published": AssetPublishedPayload;
  "asset.claimed": AssetClaimedPayload;
  "asset.royalty.received": AssetRoyaltyReceivedPayload;
  "agent.invoked": AgentInvokedPayload;
  "compute.job.completed": ComputeJobCompletedPayload;
  "reputation.delta": ReputationDeltaPayload;
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
