/**
 * Persistence layer for domain events.
 *
 * Writing happens through the singleton `db` proxy from `@/db`. Tests
 * stub `db.insert(domainEvents)…` via Drizzle test utilities.
 */

import { desc, eq, gt } from "drizzle-orm";

import { db } from "@/db";
import { domainEvents } from "@/db/schema";

import type { DomainEventEnvelope, DomainEventMap, DomainEventType } from "./domain_event_bus";

export interface PersistedDomainEvent {
  id: number;
  occurredAt: Date;
}

export async function recordDomainEvent<T extends DomainEventType>(
  type: T,
  payload: DomainEventMap[T],
  opts: { sourceTxHash?: string; sourceLogIndex?: number; version?: number } = {},
): Promise<PersistedDomainEvent> {
  const [row] = await db
    .insert(domainEvents)
    .values({
      type,
      payload: payload as Record<string, unknown>,
      sourceTxHash: opts.sourceTxHash,
      sourceLogIndex: opts.sourceLogIndex,
      version: opts.version ?? 1,
    })
    .returning({ id: domainEvents.id, occurredAt: domainEvents.occurredAt });
  return row;
}

/**
 * Read recent events for replay/debugging. Newest-first.
 */
export async function listRecentDomainEvents(limit = 100): Promise<DomainEventEnvelope[]> {
  const rows = await db
    .select()
    .from(domainEvents)
    .orderBy(desc(domainEvents.id))
    .limit(limit);
  return rows.map(toEnvelope);
}

/**
 * Read every event with id strictly greater than `sinceId`. Used by
 * subscribers that want to backfill (e.g. notification cursor).
 */
export async function listDomainEventsSince(sinceId: number): Promise<DomainEventEnvelope[]> {
  const rows = await db
    .select()
    .from(domainEvents)
    .where(gt(domainEvents.id, sinceId))
    .orderBy(domainEvents.id);
  return rows.map(toEnvelope);
}

export async function getDomainEventById(id: number): Promise<DomainEventEnvelope | null> {
  const [row] = await db.select().from(domainEvents).where(eq(domainEvents.id, id)).limit(1);
  return row ? toEnvelope(row) : null;
}

function toEnvelope(row: typeof domainEvents.$inferSelect): DomainEventEnvelope {
  return {
    id: row.id,
    type: row.type as DomainEventType,
    payload: row.payload as DomainEventMap[DomainEventType],
    occurredAt: row.occurredAt,
    sourceTxHash: row.sourceTxHash ?? undefined,
    sourceLogIndex: row.sourceLogIndex ?? undefined,
    version: row.version,
  };
}
