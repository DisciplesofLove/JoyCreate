/**
 * NotificationService — subscribes to the domain event bus and persists a
 * `notifications` row for each event the user should see.
 *
 * Boot-once: call {@link startNotificationService} from the IPC host. Idempotent.
 */

import log from "electron-log";
import { eq, isNull } from "drizzle-orm";

import { db } from "@/db";
import { notifications } from "@/db/schema";
import {
  getDomainEventBus,
  type AssetClaimedPayload,
  type AssetPublishedPayload,
  type AssetRoyaltyReceivedPayload,
  type DomainEventEnvelope,
} from "@/lib/events/domain_event_bus";

const logger = log.scope("notification_service");

let started = false;
const unsubscribers: Array<() => void> = [];

function shortAddr(a: string | undefined): string {
  if (!a) return "unknown";
  return a.length > 10 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

export function startNotificationService(): void {
  if (started) return;
  const bus = getDomainEventBus();

  unsubscribers.push(
    bus.on("asset.published", async (env) => {
      await writeFromAssetPublished(env);
    }),
    bus.on("asset.claimed", async (env) => {
      await writeFromAssetClaimed(env);
    }),
    bus.on("asset.royalty.received", async (env) => {
      await writeFromRoyalty(env);
    }),
  );

  started = true;
  logger.info("notification service started");
}

export function stopNotificationService(): void {
  for (const off of unsubscribers) off();
  unsubscribers.length = 0;
  started = false;
}

async function writeFromAssetPublished(env: DomainEventEnvelope<"asset.published">): Promise<void> {
  const p = env.payload as AssetPublishedPayload;
  await db.insert(notifications).values({
    category: "marketplace",
    priority: "medium",
    title: `${p.assetType[0].toUpperCase() + p.assetType.slice(1)} published: ${p.name}`,
    body: `On-chain by ${shortAddr(p.publisherAddress)}${p.tokenId ? ` (token #${p.tokenId})` : ""}.`,
    actionUrl: "/marketplace",
    actionLabel: "View",
    sourceEventId: env.id,
  });
}

async function writeFromAssetClaimed(env: DomainEventEnvelope<"asset.claimed">): Promise<void> {
  const p = env.payload as AssetClaimedPayload;
  await db.insert(notifications).values({
    category: "marketplace",
    priority: "high",
    title: "New marketplace sale",
    body: `Token #${p.tokenId} claimed by ${shortAddr(p.buyerAddress)}.`,
    actionUrl: "/earnings",
    actionLabel: "View Earnings",
    sourceEventId: env.id,
  });
}

async function writeFromRoyalty(env: DomainEventEnvelope<"asset.royalty.received">): Promise<void> {
  const p = env.payload as AssetRoyaltyReceivedPayload;
  await db.insert(notifications).values({
    category: "marketplace",
    priority: "medium",
    title: "Royalty received",
    body: `${p.amountUsdc} USDC routed to ${shortAddr(p.recipient)} for token #${p.tokenId}.`,
    actionUrl: "/earnings",
    actionLabel: "View",
    sourceEventId: env.id,
  });
}

// ── Read/write helpers used by IPC handlers ─────────────────────────────

export interface ListNotificationsArgs {
  /** Filter unread only. */
  unreadOnly?: boolean;
  /** Optional category filter. */
  category?: string;
  limit?: number;
}

export async function listNotifications(args: ListNotificationsArgs = {}): Promise<
  Array<typeof notifications.$inferSelect>
> {
  const limit = Math.min(args.limit ?? 100, 500);
  const rows = await db.select().from(notifications).orderBy(notifications.id).limit(1000);
  // Filter in JS — total volume is small per user; keeps query simple and
  // avoids dynamic where chaining for two optional predicates.
  const filtered = rows
    .filter((r) => !r.dismissedAt)
    .filter((r) => (args.unreadOnly ? !r.readAt : true))
    .filter((r) => (args.category ? r.category === args.category : true))
    .reverse()
    .slice(0, limit);
  return filtered;
}

export async function getUnreadCount(): Promise<number> {
  const rows = await db.select({ id: notifications.id, readAt: notifications.readAt, dismissedAt: notifications.dismissedAt }).from(notifications);
  return rows.filter((r) => !r.readAt && !r.dismissedAt).length;
}

export async function markRead(id: number): Promise<void> {
  await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(eq(notifications.id, id));
}

export async function markAllRead(): Promise<void> {
  await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(isNull(notifications.readAt));
}

export async function dismiss(id: number): Promise<void> {
  await db
    .update(notifications)
    .set({ dismissedAt: new Date() })
    .where(eq(notifications.id, id));
}
