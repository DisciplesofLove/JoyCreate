/**
 * Thin helper to write a `social` category notification. Used by the
 * publisher, engagement scanner, and the autonomous agent so the user always
 * has a feed of what the suite did on their behalf.
 */

import log from "electron-log";

import { db } from "@/db";
import { notifications } from "@/db/schema";

const logger = log.scope("social:notify");

export type SocialNotificationPriority =
  | "urgent"
  | "high"
  | "medium"
  | "low"
  | "info";

export async function notifySocial(input: {
  title: string;
  body: string;
  priority?: SocialNotificationPriority;
  actionUrl?: string;
  actionLabel?: string;
}): Promise<void> {
  try {
    await db.insert(notifications).values({
      category: "social",
      priority: input.priority ?? "info",
      title: input.title,
      body: input.body,
      actionUrl: input.actionUrl ?? null,
      actionLabel: input.actionLabel ?? null,
    });
  } catch (err) {
    logger.warn(`failed to write social notification: ${err}`);
  }
}
