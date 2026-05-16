import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { IpcClient, type NotificationRow } from "@/ipc/ipc_client";

export const NOTIFICATIONS_QUERY_KEY = ["notifications"] as const;
export const NOTIFICATIONS_UNREAD_QUERY_KEY = ["notifications", "unread-count"] as const;

export interface UseNotificationsArgs {
  unreadOnly?: boolean;
  category?: string;
  limit?: number;
}

/** Read all (filtered) notifications. Polls every 30s. */
export function useNotifications(args: UseNotificationsArgs = {}) {
  return useQuery<NotificationRow[]>({
    queryKey: [...NOTIFICATIONS_QUERY_KEY, args],
    queryFn: () => IpcClient.getInstance().listNotifications(args),
    refetchInterval: 30_000,
  });
}

/** Lightweight unread badge count. Polls every 15s. */
export function useUnreadNotificationCount() {
  return useQuery<number>({
    queryKey: NOTIFICATIONS_UNREAD_QUERY_KEY,
    queryFn: () => IpcClient.getInstance().getUnreadNotificationCount(),
    refetchInterval: 15_000,
  });
}

export function useMarkNotificationRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => IpcClient.getInstance().markNotificationRead(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: NOTIFICATIONS_QUERY_KEY });
      qc.invalidateQueries({ queryKey: NOTIFICATIONS_UNREAD_QUERY_KEY });
    },
    onError: (err) => toast.error(`Failed to mark read: ${(err as Error).message}`),
  });
}

export function useMarkAllNotificationsRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => IpcClient.getInstance().markAllNotificationsRead(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: NOTIFICATIONS_QUERY_KEY });
      qc.invalidateQueries({ queryKey: NOTIFICATIONS_UNREAD_QUERY_KEY });
      toast.success("All notifications marked as read");
    },
    onError: (err) => toast.error(`Failed: ${(err as Error).message}`),
  });
}

export function useDismissNotification() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => IpcClient.getInstance().dismissNotification(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: NOTIFICATIONS_QUERY_KEY });
      qc.invalidateQueries({ queryKey: NOTIFICATIONS_UNREAD_QUERY_KEY });
    },
    onError: (err) => toast.error(`Failed to dismiss: ${(err as Error).message}`),
  });
}
