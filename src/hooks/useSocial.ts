/**
 * TanStack Query hooks for the agent-managed social suite.
 *
 * Reads use `useQuery`; writes use `useMutation` and invalidate the relevant
 * query keys. All IPC handlers throw on error, surfaced via the mutation's
 * error state / the caller's try-catch + toast.
 */

import {
  type UseMutationResult,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import type {
  SocialCampaignCadence,
  SocialEngagementStatus,
  SocialPostContent,
  SocialPostStatus,
  SocialProvider,
} from "@/db/social_schema";
import type {
  SocialAgentSettingsDto,
  SocialAgentStatusDto,
} from "@/ipc/handlers/social_agent_handlers";
import type {
  SocialAnalyticsOverview,
  SocialPostMetricSeries,
} from "@/ipc/handlers/social_analytics_handlers";
import type { SocialCampaignDto } from "@/ipc/handlers/social_content_handlers";
import type {
  SocialEngagementDto,
} from "@/ipc/handlers/social_engagement_handlers";
import type {
  SocialAccountDto,
  SocialPostDto,
} from "@/ipc/handlers/social_handlers";
import { IpcClient } from "@/ipc/ipc_client";
import type {
  GeneratedDraft,
  ParsedCampaignSetup,
  PlannedSlot,
} from "@/lib/social/content_engine";
import type { SocialProviderInfo } from "@/lib/social/registry";
import type { AgentSettingsPatch } from "@/lib/social/social_agent";

// ── Query keys ──────────────────────────────────────────────────────────

export const socialKeys = {
  providers: ["social", "providers"] as const,
  providerConfig: ["social", "provider-config"] as const,
  accounts: ["social", "accounts"] as const,
  posts: ["social", "posts"] as const,
  campaigns: ["social", "campaigns"] as const,
  engagements: ["social", "engagements"] as const,
  analytics: ["social", "analytics"] as const,
  postMetrics: ["social", "post-metrics"] as const,
  agentSettings: ["social", "agent-settings"] as const,
  agentStatus: ["social", "agent-status"] as const,
};

function ipc() {
  return IpcClient.getInstance();
}

// ── Providers + accounts ──────────────────────────────────────────────────

export function useSocialProviders() {
  return useQuery<SocialProviderInfo[]>({
    queryKey: socialKeys.providers,
    queryFn: () => ipc().listSocialProviders(),
    staleTime: 5 * 60_000,
  });
}

export function useSocialProviderConfig() {
  return useQuery({
    queryKey: socialKeys.providerConfig,
    queryFn: () => ipc().getSocialProviderConfig(),
    staleTime: 60_000,
  });
}

export function useSocialAccounts() {
  return useQuery<SocialAccountDto[]>({
    queryKey: socialKeys.accounts,
    queryFn: () => ipc().listSocialAccounts(),
    staleTime: 30_000,
  });
}

export function useUpdateSocialAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      accountId: number;
      enabled?: boolean;
      autoReply?: boolean;
      label?: string;
    }) => ipc().updateSocialAccount(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: socialKeys.accounts });
    },
  });
}

export function useDisconnectSocialAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (accountId: number) => ipc().disconnectSocialAccount(accountId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: socialKeys.accounts });
    },
  });
}

export function useSetSocialAppCredentials() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      provider: SocialProvider;
      clientId: string;
      clientSecret?: string;
      redirectUri?: string;
    }) => ipc().setSocialAppCredentials(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: socialKeys.providerConfig });
      qc.invalidateQueries({ queryKey: socialKeys.providers });
    },
  });
}

export function useBeginSocialOAuth() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (provider: SocialProvider) => ipc().beginSocialOAuth(provider),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: socialKeys.accounts });
    },
  });
}

// ── Posts ──────────────────────────────────────────────────────────────

export function useSocialPosts(args?: {
  status?: SocialPostStatus | SocialPostStatus[];
  campaignId?: number;
  limit?: number;
}) {
  return useQuery<SocialPostDto[]>({
    queryKey: [...socialKeys.posts, args ?? null],
    queryFn: () => ipc().listSocialPosts(args),
    refetchInterval: 60_000,
  });
}

function useInvalidatePosts() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: socialKeys.posts });
    qc.invalidateQueries({ queryKey: socialKeys.analytics });
    qc.invalidateQueries({ queryKey: socialKeys.agentStatus });
  };
}

export function useCreateSocialPost() {
  const invalidate = useInvalidatePosts();
  return useMutation({
    mutationFn: (input: {
      content: SocialPostContent;
      accountIds: number[];
      scheduledFor?: number | null;
      campaignId?: number | null;
      source?: SocialPostDto["source"];
      status?: SocialPostStatus;
    }) => ipc().createSocialPost(input),
    onSuccess: invalidate,
  });
}

export function useUpdateSocialPost() {
  const invalidate = useInvalidatePosts();
  return useMutation({
    mutationFn: (input: {
      postId: number;
      content?: SocialPostContent;
      scheduledFor?: number | null;
    }) => ipc().updateSocialPost(input),
    onSuccess: invalidate,
  });
}

export function useDeleteSocialPost() {
  const invalidate = useInvalidatePosts();
  return useMutation({
    mutationFn: (postId: number) => ipc().deleteSocialPost(postId),
    onSuccess: invalidate,
  });
}

export function usePublishSocialPost() {
  const invalidate = useInvalidatePosts();
  return useMutation({
    mutationFn: (postId: number) => ipc().publishSocialPost(postId),
    onSuccess: invalidate,
  });
}

export function useScheduleSocialPost() {
  const invalidate = useInvalidatePosts();
  return useMutation({
    mutationFn: (input: { postId: number; scheduledFor: number }) =>
      ipc().scheduleSocialPost(input),
    onSuccess: invalidate,
  });
}

export function useApproveSocialPost() {
  const invalidate = useInvalidatePosts();
  return useMutation({
    mutationFn: (postId: number) => ipc().approveSocialPost(postId),
    onSuccess: invalidate,
  });
}

export function useRejectSocialPost() {
  const invalidate = useInvalidatePosts();
  return useMutation({
    mutationFn: (postId: number) => ipc().rejectSocialPost(postId),
    onSuccess: invalidate,
  });
}

// ── Content generation ────────────────────────────────────────────────────

export function useGenerateSocialDrafts(): UseMutationResult<
  GeneratedDraft[],
  Error,
  {
    topics: string[];
    provider?: SocialProvider;
    tone?: string;
    audience?: string;
    brandVoice?: string;
    count?: number;
    includeImagePrompt?: boolean;
  }
> {
  return useMutation({
    mutationFn: (input) => ipc().generateSocialDrafts(input),
  });
}

export function useParseSocialSetup(): UseMutationResult<
  ParsedCampaignSetup,
  Error,
  string
> {
  return useMutation({
    mutationFn: (instruction) => ipc().parseSocialSetup(instruction),
  });
}

export function usePlanSocialCalendar(): UseMutationResult<
  PlannedSlot[],
  Error,
  {
    campaignId?: number;
    cadence?: SocialCampaignCadence;
    topics?: string[];
    count?: number;
    fromMs?: number;
  }
> {
  return useMutation({
    mutationFn: (input) => ipc().planSocialCalendar(input),
  });
}

export function useGenerateSocialImage(): UseMutationResult<
  { filePath: string; dataUrl: string },
  Error,
  {
    prompt: string;
    provider: string;
    model: string;
    width?: number;
    height?: number;
    negativePrompt?: string;
    style?: string;
  }
> {
  return useMutation({
    mutationFn: (input) => ipc().generateSocialImage(input),
  });
}

export function useImageProviders() {
  return useQuery({
    queryKey: ["social", "image-providers"],
    queryFn: () => ipc().getAvailableImageProviders(),
    staleTime: 5 * 60_000,
  });
}

// ── Campaigns ──────────────────────────────────────────────────────────

export function useSocialCampaigns() {
  return useQuery<SocialCampaignDto[]>({
    queryKey: socialKeys.campaigns,
    queryFn: () => ipc().listSocialCampaigns(),
    staleTime: 30_000,
  });
}

function useInvalidateCampaigns() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: socialKeys.campaigns });
    qc.invalidateQueries({ queryKey: socialKeys.agentStatus });
  };
}

export function useCreateSocialCampaign() {
  const invalidate = useInvalidateCampaigns();
  return useMutation({
    mutationFn: (input: Parameters<IpcClient["createSocialCampaign"]>[0]) =>
      ipc().createSocialCampaign(input),
    onSuccess: invalidate,
  });
}

export function useUpdateSocialCampaign() {
  const invalidate = useInvalidateCampaigns();
  return useMutation({
    mutationFn: (input: Parameters<IpcClient["updateSocialCampaign"]>[0]) =>
      ipc().updateSocialCampaign(input),
    onSuccess: invalidate,
  });
}

export function useDeleteSocialCampaign() {
  const invalidate = useInvalidateCampaigns();
  return useMutation({
    mutationFn: (campaignId: number) => ipc().deleteSocialCampaign(campaignId),
    onSuccess: invalidate,
  });
}

export function useGenerateCampaignNow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { campaignId: number; count?: number }) =>
      ipc().generateCampaignNow(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: socialKeys.posts });
      qc.invalidateQueries({ queryKey: socialKeys.agentStatus });
    },
  });
}

// ── Engagement inbox ────────────────────────────────────────────────────

export function useSocialEngagements(args?: {
  status?: SocialEngagementStatus;
  accountId?: number;
  limit?: number;
}) {
  return useQuery<SocialEngagementDto[]>({
    queryKey: [...socialKeys.engagements, args ?? null],
    queryFn: () => ipc().listSocialEngagements(args),
    refetchInterval: 60_000,
  });
}

function useInvalidateEngagements() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: socialKeys.engagements });
    qc.invalidateQueries({ queryKey: socialKeys.agentStatus });
  };
}

export function useSyncSocialEngagements() {
  const invalidate = useInvalidateEngagements();
  return useMutation({
    mutationFn: (args?: { accountId?: number }) =>
      ipc().syncSocialEngagements(args),
    onSuccess: invalidate,
  });
}

export function useSuggestSocialReply(): UseMutationResult<
  { text: string },
  Error,
  { engagementId: number; tone?: string; postContext?: string }
> {
  return useMutation({
    mutationFn: (input) => ipc().suggestSocialReply(input),
  });
}

export function useSendSocialReply() {
  const invalidate = useInvalidateEngagements();
  return useMutation({
    mutationFn: (input: { engagementId: number; text: string }) =>
      ipc().sendSocialReply(input),
    onSuccess: invalidate,
  });
}

export function useApproveSocialReply() {
  const invalidate = useInvalidateEngagements();
  return useMutation({
    mutationFn: (replyId: number) => ipc().approveSocialReply(replyId),
    onSuccess: invalidate,
  });
}

export function useDismissSocialReply() {
  const invalidate = useInvalidateEngagements();
  return useMutation({
    mutationFn: (replyId: number) => ipc().dismissSocialReply(replyId),
    onSuccess: invalidate,
  });
}

export function useMarkSocialEngagement() {
  const invalidate = useInvalidateEngagements();
  return useMutation({
    mutationFn: (input: {
      engagementId: number;
      status: SocialEngagementStatus;
    }) => ipc().markSocialEngagement(input),
    onSuccess: invalidate,
  });
}

// ── Analytics ──────────────────────────────────────────────────────────

export function useSocialAnalyticsOverview() {
  return useQuery<SocialAnalyticsOverview>({
    queryKey: socialKeys.analytics,
    queryFn: () => ipc().getSocialAnalyticsOverview(),
    refetchInterval: 60_000,
  });
}

export function useSocialPostMetrics(postId: number | null) {
  return useQuery<SocialPostMetricSeries[]>({
    queryKey: [...socialKeys.postMetrics, postId],
    queryFn: () => ipc().getSocialPostMetrics(postId as number),
    enabled: typeof postId === "number",
  });
}

export function useSyncSocialMetrics() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args?: { postId?: number }) => ipc().syncSocialMetrics(args),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: socialKeys.analytics });
      qc.invalidateQueries({ queryKey: socialKeys.postMetrics });
    },
  });
}

// ── Agent ──────────────────────────────────────────────────────────────

export function useSocialAgentSettings() {
  return useQuery<SocialAgentSettingsDto>({
    queryKey: socialKeys.agentSettings,
    queryFn: () => ipc().getSocialAgentSettings(),
    staleTime: 30_000,
  });
}

export function useSocialAgentStatus() {
  return useQuery<SocialAgentStatusDto>({
    queryKey: socialKeys.agentStatus,
    queryFn: () => ipc().getSocialAgentStatus(),
    refetchInterval: 30_000,
  });
}

export function useSetSocialAgentSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: AgentSettingsPatch) =>
      ipc().setSocialAgentSettings(patch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: socialKeys.agentSettings });
      qc.invalidateQueries({ queryKey: socialKeys.agentStatus });
    },
  });
}

export function useRunSocialAgentNow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => ipc().runSocialAgentNow(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: socialKeys.posts });
      qc.invalidateQueries({ queryKey: socialKeys.engagements });
      qc.invalidateQueries({ queryKey: socialKeys.agentStatus });
    },
  });
}
