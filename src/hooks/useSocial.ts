/**
 * TanStack Query hooks for the social posting IPC channels.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { IpcClient } from "@/ipc/ipc_client";
import type {
  SocialAccountDto,
  SocialScheduledPostDto,
} from "@/ipc/handlers/social_handlers";
import type { SocialPostPayload, SocialProvider } from "@/db/social_schema";

export const SOCIAL_ACCOUNTS_KEY = ["social", "accounts"] as const;
export const SOCIAL_SCHEDULED_KEY = ["social", "scheduled"] as const;
export const SOCIAL_PROVIDERS_KEY = ["social", "providers"] as const;

export function useSocialProviders() {
  return useQuery<SocialProvider[]>({
    queryKey: SOCIAL_PROVIDERS_KEY,
    queryFn: () => IpcClient.getInstance().listSocialProviders(),
    staleTime: Infinity,
  });
}

export function useSocialAccounts() {
  return useQuery<SocialAccountDto[]>({
    queryKey: SOCIAL_ACCOUNTS_KEY,
    queryFn: () => IpcClient.getInstance().listSocialAccounts(),
    staleTime: 60_000,
  });
}

export function useScheduledSocialPosts(args?: {
  accountId?: number;
  sinceMs?: number;
}) {
  return useQuery<SocialScheduledPostDto[]>({
    queryKey: [...SOCIAL_SCHEDULED_KEY, args ?? null],
    queryFn: () => IpcClient.getInstance().listScheduledSocialPosts(args),
    refetchInterval: 60_000,
  });
}

export function useConnectSocialAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      provider: SocialProvider;
      authCode?: string;
      extras?: Record<string, unknown>;
    }) => IpcClient.getInstance().connectSocialAccount(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: SOCIAL_ACCOUNTS_KEY });
    },
  });
}

export function useDisconnectSocialAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (accountId: number) =>
      IpcClient.getInstance().disconnectSocialAccount(accountId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: SOCIAL_ACCOUNTS_KEY });
      qc.invalidateQueries({ queryKey: SOCIAL_SCHEDULED_KEY });
    },
  });
}

export function usePostSocial() {
  return useMutation({
    mutationFn: (input: { accountId: number; payload: SocialPostPayload }) =>
      IpcClient.getInstance().postSocial(input),
  });
}

export function useScheduleSocialPost() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      accountId: number;
      payload: SocialPostPayload;
      scheduledFor: number;
    }) => IpcClient.getInstance().scheduleSocialPost(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: SOCIAL_SCHEDULED_KEY });
    },
  });
}

export function useCancelScheduledSocialPost() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) =>
      IpcClient.getInstance().cancelScheduledSocialPost(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: SOCIAL_SCHEDULED_KEY });
    },
  });
}
