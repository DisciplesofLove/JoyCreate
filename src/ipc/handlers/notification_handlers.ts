/**
 * IPC handlers for the in-app notification center.
 *
 * Channels:
 *   notifications:list             → Notification[]
 *   notifications:unread-count     → number
 *   notifications:mark-read        → void   (id)
 *   notifications:mark-all-read    → void
 *   notifications:dismiss          → void   (id)
 */

import { ipcMain } from "electron";
import log from "electron-log";

import {
  dismiss,
  getUnreadCount,
  listNotifications,
  markAllRead,
  markRead,
  startNotificationService,
  type ListNotificationsArgs,
} from "@/lib/notifications/notification_service";

const logger = log.scope("notification_handlers");

export function registerNotificationHandlers(): void {
  // Boot the subscriber once handlers are registered.
  startNotificationService();

  ipcMain.handle("notifications:list", async (_event, args: ListNotificationsArgs = {}) => {
    return listNotifications(args);
  });

  ipcMain.handle("notifications:unread-count", async () => {
    return getUnreadCount();
  });

  ipcMain.handle("notifications:mark-read", async (_event, id: number) => {
    if (typeof id !== "number" || !Number.isFinite(id)) {
      throw new Error("notifications:mark-read requires a numeric id");
    }
    await markRead(id);
  });

  ipcMain.handle("notifications:mark-all-read", async () => {
    await markAllRead();
  });

  ipcMain.handle("notifications:dismiss", async (_event, id: number) => {
    if (typeof id !== "number" || !Number.isFinite(id)) {
      throw new Error("notifications:dismiss requires a numeric id");
    }
    await dismiss(id);
  });

  logger.info("notification handlers registered");
}
