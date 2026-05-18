/**
 * React Query hooks for agent schedules.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { IpcClient } from "@/ipc/ipc_client";

export type ScheduleTrigger =
  | { type: "interval"; everyMinutes: number }
  | { type: "daily"; atHour: number; atMinute: number }
  | { type: "weekly"; weekday: number; atHour: number; atMinute: number };

export interface ScheduleTTSConfig {
  enabled: boolean;
  voice?: string;
  speed?: number;
  maxChars?: number;
}

export interface ScheduleNotificationTargets {
  joyAssistant?: boolean;
  openclaw?: { clientId: string; channelId: string };
}

export interface AgentSchedule {
  id: string;
  agentId: string;
  name: string;
  brief: string;
  trigger: ScheduleTrigger;
  enabled: boolean;
  tts?: ScheduleTTSConfig;
  notifications?: ScheduleNotificationTargets;
  lastRunAt: string | null;
  lastRunStatus: "completed" | "failed" | null;
  lastRunError: string | null;
  lastAudioPath: string | null;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduleHistoryEntry {
  id: string;
  scheduleId: string;
  agentId: string;
  startedAt: string;
  finishedAt: string;
  status: "completed" | "failed";
  outputPreview: string;
  error?: string;
  executionId?: string;
  audioPath?: string;
  audioDuration?: number;
}

const SCHEDULES_KEY = ["agent-schedules"] as const;
const HISTORY_KEY = ["agent-schedule-history"] as const;

export function useAgentSchedules(agentId?: string) {
  return useQuery({
    queryKey: [...SCHEDULES_KEY, agentId ?? "__all__"],
    queryFn: async (): Promise<AgentSchedule[]> => {
      const res = await IpcClient.getInstance().listAgentSchedules(
        agentId ? { agentId } : undefined,
      );
      return res.schedules;
    },
  });
}

export function useAgentScheduleHistory(scheduleId?: string, limit = 50) {
  return useQuery({
    queryKey: [...HISTORY_KEY, scheduleId ?? "__all__", limit],
    queryFn: async (): Promise<ScheduleHistoryEntry[]> => {
      const res = await IpcClient.getInstance().listAgentScheduleHistory({
        scheduleId,
        limit,
      });
      return res.history;
    },
  });
}

export function useCreateAgentSchedule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: {
      agentId: string;
      name: string;
      brief: string;
      trigger: ScheduleTrigger;
      enabled?: boolean;
      tts?: ScheduleTTSConfig;
      notifications?: ScheduleNotificationTargets;
    }) => {
      if (!args.agentId) throw new Error("Pick an agent first");
      if (!args.name.trim()) throw new Error("Name is required");
      if (!args.brief.trim()) throw new Error("Brief is required");
      const res = await IpcClient.getInstance().createAgentSchedule(args);
      return res.schedule as AgentSchedule;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: SCHEDULES_KEY });
    },
  });
}

export function useUpdateAgentSchedule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: { id: string; patch: Partial<AgentSchedule> }) => {
      const res = await IpcClient.getInstance().updateAgentSchedule(args);
      return res.schedule as AgentSchedule;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: SCHEDULES_KEY });
    },
  });
}

export function useDeleteAgentSchedule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await IpcClient.getInstance().deleteAgentSchedule(id);
      return id;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: SCHEDULES_KEY });
      qc.invalidateQueries({ queryKey: HISTORY_KEY });
    },
  });
}

export function useToggleAgentSchedule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: { id: string; enabled: boolean }) => {
      const res = await IpcClient.getInstance().toggleAgentSchedule(args);
      return res.schedule as AgentSchedule;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: SCHEDULES_KEY });
    },
  });
}

export function useRunAgentScheduleNow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const res = await IpcClient.getInstance().runAgentScheduleNow(id);
      return res.schedule as AgentSchedule;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: SCHEDULES_KEY });
      qc.invalidateQueries({ queryKey: HISTORY_KEY });
    },
  });
}
