/**
 * Agent Schedule Handlers
 *
 * Lightweight in-process scheduler for running agents on a recurring trigger.
 * No external cron dependency — schedules are persisted to disk and a 30s
 * tick loop fires any due runs by delegating to `executeAgentByIdInternal`.
 *
 * Trigger types:
 *   - { type: "interval", everyMinutes: number }
 *   - { type: "daily",    atHour: 0-23, atMinute: 0-59 }
 *   - { type: "weekly",   weekday: 0-6 (Sun=0), atHour, atMinute }
 *
 * Channels (all throw on error):
 *   agent-schedules:list           ({ agentId? }?) -> { success, schedules }
 *   agent-schedules:create         (args)          -> { success, schedule }
 *   agent-schedules:update         (id, patch)     -> { success, schedule }
 *   agent-schedules:delete         (id)            -> { success }
 *   agent-schedules:toggle         (id, enabled)   -> { success, schedule }
 *   agent-schedules:run-now        (id)            -> { success, run }
 *   agent-schedules:list-history   ({ scheduleId?, limit? }?) -> { success, history }
 */

import { app, ipcMain } from "electron";
import path from "path";
import fs from "fs-extra";
import { v4 as uuidv4 } from "uuid";
import log from "electron-log";

import {
  executeAgentByIdInternal,
  agentExistsInternal,
  getAgentNameInternal,
} from "./agent_builder_system_handlers";
import { notifyAgentRun } from "@/lib/agent_notifier";

const logger = log.scope("agent-schedules");

// ============================================================================
// Types
// ============================================================================

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

interface ScheduleHistoryEntry {
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

// ============================================================================
// Storage
// ============================================================================

const schedules: Map<string, AgentSchedule> = new Map();
const history: ScheduleHistoryEntry[] = [];
const MAX_HISTORY = 200;

let tickHandle: NodeJS.Timeout | null = null;
const TICK_INTERVAL_MS = 30_000;

// ----------------------------------------------------------------------------
// Exposed helpers — used by other handler modules (e.g. the OpenClaw Command
// Center alias handlers) so they can read the schedule store without going
// through ipcMain.invoke. Keep these read-mostly; mutations must still go
// through the registered ipcMain handlers above so persistence/scheduling
// stay consistent.
// ----------------------------------------------------------------------------
export function getAllAgentSchedules(): AgentSchedule[] {
  return Array.from(schedules.values());
}

export function getAgentSchedule(id: string): AgentSchedule | undefined {
  return schedules.get(id);
}

export function getRecentScheduleHistory(
  limit?: number,
): ScheduleHistoryEntry[] {
  const result = history.slice().reverse();
  return typeof limit === "number" && limit > 0 ? result.slice(0, limit) : result;
}
const inFlight: Set<string> = new Set();

function storageDir(): string {
  return path.join(app.getPath("userData"), "agents");
}

function schedulesPath(): string {
  return path.join(storageDir(), "schedules.json");
}

function historyPath(): string {
  return path.join(storageDir(), "schedule_history.json");
}

async function loadFromDisk(): Promise<void> {
  await fs.ensureDir(storageDir());

  const sPath = schedulesPath();
  if (await fs.pathExists(sPath)) {
    try {
      const data = (await fs.readJson(sPath)) as AgentSchedule[];
      for (const s of data) {
        if (s.lastAudioPath === undefined) s.lastAudioPath = null;
        schedules.set(s.id, s);
      }
    } catch (err) {
      logger.warn("Failed to read schedules.json:", err);
    }
  }

  const hPath = historyPath();
  if (await fs.pathExists(hPath)) {
    try {
      const data = (await fs.readJson(hPath)) as ScheduleHistoryEntry[];
      history.push(...data);
    } catch (err) {
      logger.warn("Failed to read schedule_history.json:", err);
    }
  }

  for (const s of schedules.values()) {
    s.nextRunAt = computeNextRun(s, new Date()).toISOString();
  }
}

async function persistSchedules(): Promise<void> {
  await fs.writeJson(schedulesPath(), Array.from(schedules.values()), {
    spaces: 2,
  });
}

async function persistHistory(): Promise<void> {
  await fs.writeJson(historyPath(), history.slice(-MAX_HISTORY), { spaces: 2 });
}

// ============================================================================
// Trigger math
// ============================================================================

function validateTrigger(t: ScheduleTrigger): void {
  if (!t || typeof t !== "object") throw new Error("Invalid trigger");
  switch (t.type) {
    case "interval":
      if (!Number.isFinite(t.everyMinutes) || t.everyMinutes < 1) {
        throw new Error("interval.everyMinutes must be >= 1");
      }
      break;
    case "daily":
      if (!Number.isInteger(t.atHour) || t.atHour < 0 || t.atHour > 23) {
        throw new Error("daily.atHour must be 0-23");
      }
      if (!Number.isInteger(t.atMinute) || t.atMinute < 0 || t.atMinute > 59) {
        throw new Error("daily.atMinute must be 0-59");
      }
      break;
    case "weekly":
      if (!Number.isInteger(t.weekday) || t.weekday < 0 || t.weekday > 6) {
        throw new Error("weekly.weekday must be 0-6 (Sun=0)");
      }
      if (!Number.isInteger(t.atHour) || t.atHour < 0 || t.atHour > 23) {
        throw new Error("weekly.atHour must be 0-23");
      }
      if (!Number.isInteger(t.atMinute) || t.atMinute < 0 || t.atMinute > 59) {
        throw new Error("weekly.atMinute must be 0-59");
      }
      break;
    default:
      throw new Error("Unknown trigger type");
  }
}

function computeNextRun(s: AgentSchedule, now: Date): Date {
  const t = s.trigger;
  const last = s.lastRunAt ? new Date(s.lastRunAt) : null;

  if (t.type === "interval") {
    const base = last ?? now;
    return new Date(base.getTime() + t.everyMinutes * 60_000);
  }

  if (t.type === "daily") {
    const next = new Date(now);
    next.setHours(t.atHour, t.atMinute, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    return next;
  }

  // weekly
  const next = new Date(now);
  next.setHours(t.atHour, t.atMinute, 0, 0);
  const todayDow = next.getDay();
  let dayDelta = (t.weekday - todayDow + 7) % 7;
  if (dayDelta === 0 && next <= now) dayDelta = 7;
  next.setDate(next.getDate() + dayDelta);
  return next;
}

function isDue(s: AgentSchedule, now: Date): boolean {
  if (!s.enabled) return false;
  if (!s.nextRunAt) return true;
  return new Date(s.nextRunAt).getTime() <= now.getTime();
}

// Lazy-loaded TTS to avoid pulling the voice-assistant module into
// the scheduler bootstrap path. Returns null if TTS is unavailable.
async function speakSafely(args: {
  text: string;
  voice?: string;
  speed?: number;
}): Promise<{ audioPath: string; duration: number } | null> {
  try {
    const mod = await import("@/lib/voice_assistant");
    const va = mod.voiceAssistant;
    const result = await va.speak({
      text: args.text,
      voice: args.voice,
      speed: args.speed,
    });
    if (result && result.audioPath) {
      return { audioPath: result.audioPath, duration: result.duration };
    }
    return null;
  } catch (err) {
    logger.warn("speakSafely: voice assistant unavailable:", err);
    return null;
  }
}

// ============================================================================
// Tick loop
// ============================================================================

async function runScheduleOnce(s: AgentSchedule): Promise<void> {
  if (inFlight.has(s.id)) return;
  inFlight.add(s.id);
  const startedAt = new Date();
  try {
    if (!agentExistsInternal(s.agentId)) {
      throw new Error(`Agent ${s.agentId} no longer exists`);
    }
    const res = await executeAgentByIdInternal(
      s.agentId,
      s.brief,
      undefined,
      "schedule",
    );
    const finishedAt = new Date();
    const ok = res.success === true;
    s.lastRunAt = startedAt.toISOString();
    s.lastRunStatus = ok ? "completed" : "failed";
    s.lastRunError = ok ? null : res.error || "Unknown error";
    s.nextRunAt = computeNextRun(s, finishedAt).toISOString();
    s.updatedAt = finishedAt.toISOString();

    const preview =
      typeof res.output === "string"
        ? res.output
        : (() => {
            try {
              return JSON.stringify(res.output);
            } catch {
              return String(res.output);
            }
          })();

    let audioPath: string | undefined;
    let audioDuration: number | undefined;
    if (ok && s.tts?.enabled && preview) {
      try {
        const tts = await speakSafely({
          text: preview.slice(0, s.tts.maxChars ?? 4000),
          voice: s.tts.voice,
          speed: s.tts.speed,
        });
        if (tts) {
          audioPath = tts.audioPath;
          audioDuration = tts.duration;
          s.lastAudioPath = audioPath;
        }
      } catch (e) {
        logger.warn(`TTS failed for schedule ${s.id}:`, e);
      }
    }

    history.push({
      id: uuidv4(),
      scheduleId: s.id,
      agentId: s.agentId,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      status: ok ? "completed" : "failed",
      outputPreview: preview ? preview.slice(0, 2000) : "",
      error: ok ? undefined : res.error,
      executionId: res.executionId,
      audioPath,
      audioDuration,
    });
    if (history.length > MAX_HISTORY) {
      history.splice(0, history.length - MAX_HISTORY);
    }
    await Promise.all([persistSchedules(), persistHistory()]);
    logger.info(
      `Schedule ${s.id} (${s.name}) ${ok ? "completed" : "failed"} in ${
        finishedAt.getTime() - startedAt.getTime()
      }ms`,
    );

    if (s.notifications) {
      await notifyAgentRun(
        {
          executionId: res.executionId,
          agentId: s.agentId,
          agentName: res.agentName,
          status: ok ? "completed" : "failed",
          source: "schedule",
          preview,
          error: ok ? undefined : res.error,
          startedAt: startedAt.toISOString(),
          completedAt: finishedAt.toISOString(),
          audioPath,
        },
        s.notifications,
      );
    }
  } catch (err) {
    const finishedAt = new Date();
    const msg = err instanceof Error ? err.message : String(err);
    s.lastRunAt = startedAt.toISOString();
    s.lastRunStatus = "failed";
    s.lastRunError = msg;
    s.nextRunAt = computeNextRun(s, finishedAt).toISOString();
    s.updatedAt = finishedAt.toISOString();
    history.push({
      id: uuidv4(),
      scheduleId: s.id,
      agentId: s.agentId,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      status: "failed",
      outputPreview: "",
      error: msg,
    });
    if (history.length > MAX_HISTORY) {
      history.splice(0, history.length - MAX_HISTORY);
    }
    await Promise.all([persistSchedules(), persistHistory()]);
    logger.error(`Schedule ${s.id} (${s.name}) errored:`, err);

    if (s.notifications) {
      await notifyAgentRun(
        {
          executionId: "schedule-error",
          agentId: s.agentId,
          agentName: getAgentNameInternal(s.agentId) ?? s.name,
          status: "failed",
          source: "schedule",
          preview: "",
          error: msg,
          startedAt: startedAt.toISOString(),
          completedAt: finishedAt.toISOString(),
        },
        s.notifications,
      );
    }
  } finally {
    inFlight.delete(s.id);
  }
}

async function tick(): Promise<void> {
  const now = new Date();
  const due = Array.from(schedules.values()).filter((s) => isDue(s, now));
  for (const s of due) {
    // fire-and-forget; each run is independently logged
    runScheduleOnce(s).catch((e) =>
      logger.error("runScheduleOnce uncaught:", e),
    );
  }
}

function startSchedulerLoop(): void {
  if (tickHandle) return;
  tickHandle = setInterval(() => {
    tick().catch((e) => logger.error("tick failed:", e));
  }, TICK_INTERVAL_MS);
  // Run an initial tick after a short delay so we don't fire on startup
  // simultaneously with handler registration.
  setTimeout(() => {
    tick().catch((e) => logger.error("initial tick failed:", e));
  }, 5_000);
}

// ============================================================================
// IPC handlers
// ============================================================================

export function registerAgentScheduleHandlers(): void {
  loadFromDisk()
    .then(() => {
      startSchedulerLoop();
      logger.info(`Loaded ${schedules.size} agent schedules`);
    })
    .catch((err) => logger.error("Failed to initialize schedules:", err));

  ipcMain.handle(
    "agent-schedules:list",
    async (_event, args?: { agentId?: string }) => {
      try {
        let result = Array.from(schedules.values());
        if (args?.agentId) {
          result = result.filter((s) => s.agentId === args.agentId);
        }
        return { success: true, schedules: result };
      } catch (err) {
        logger.error("list schedules failed:", err);
        throw err;
      }
    },
  );

  ipcMain.handle(
    "agent-schedules:create",
    async (
      _event,
      args: {
        agentId: string;
        name: string;
        brief: string;
        trigger: ScheduleTrigger;
        enabled?: boolean;
        tts?: ScheduleTTSConfig;
        notifications?: ScheduleNotificationTargets;
      },
    ) => {
      try {
        if (!args?.agentId) throw new Error("agentId is required");
        if (!args?.name?.trim()) throw new Error("name is required");
        if (!args?.brief?.trim()) throw new Error("brief is required");
        if (!agentExistsInternal(args.agentId)) {
          throw new Error(`Agent ${args.agentId} not found`);
        }
        validateTrigger(args.trigger);

        const now = new Date();
        const schedule: AgentSchedule = {
          id: uuidv4(),
          agentId: args.agentId,
          name: args.name.trim(),
          brief: args.brief.trim(),
          trigger: args.trigger,
          enabled: args.enabled !== false,
          tts: args.tts && args.tts.enabled ? { ...args.tts, enabled: true } : undefined,
          notifications: args.notifications,
          lastRunAt: null,
          lastRunStatus: null,
          lastRunError: null,
          lastAudioPath: null,
          nextRunAt: "",
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        };
        schedule.nextRunAt = computeNextRun(schedule, now).toISOString();
        schedules.set(schedule.id, schedule);
        await persistSchedules();
        return { success: true, schedule };
      } catch (err) {
        logger.error("create schedule failed:", err);
        throw err;
      }
    },
  );

  ipcMain.handle(
    "agent-schedules:update",
    async (
      _event,
      args: {
        id: string;
        patch: Partial<
          Pick<
            AgentSchedule,
            "name" | "brief" | "trigger" | "enabled" | "tts" | "notifications"
          >
        >;
      },
    ) => {
      try {
        if (!args?.id) throw new Error("id is required");
        const s = schedules.get(args.id);
        if (!s) throw new Error("Schedule not found");
        const patch = args.patch ?? {};
        if (patch.trigger) validateTrigger(patch.trigger);
        const updated: AgentSchedule = {
          ...s,
          ...patch,
          updatedAt: new Date().toISOString(),
        };
        updated.nextRunAt = computeNextRun(updated, new Date()).toISOString();
        schedules.set(updated.id, updated);
        await persistSchedules();
        return { success: true, schedule: updated };
      } catch (err) {
        logger.error("update schedule failed:", err);
        throw err;
      }
    },
  );

  ipcMain.handle("agent-schedules:delete", async (_event, id: string) => {
    try {
      if (!id) throw new Error("id is required");
      if (!schedules.has(id)) throw new Error("Schedule not found");
      schedules.delete(id);
      await persistSchedules();
      return { success: true };
    } catch (err) {
      logger.error("delete schedule failed:", err);
      throw err;
    }
  });

  ipcMain.handle(
    "agent-schedules:toggle",
    async (_event, args: { id: string; enabled: boolean }) => {
      try {
        const s = schedules.get(args.id);
        if (!s) throw new Error("Schedule not found");
        s.enabled = !!args.enabled;
        s.updatedAt = new Date().toISOString();
        s.nextRunAt = computeNextRun(s, new Date()).toISOString();
        await persistSchedules();
        return { success: true, schedule: s };
      } catch (err) {
        logger.error("toggle schedule failed:", err);
        throw err;
      }
    },
  );

  ipcMain.handle("agent-schedules:run-now", async (_event, id: string) => {
    try {
      const s = schedules.get(id);
      if (!s) throw new Error("Schedule not found");
      await runScheduleOnce(s);
      return { success: true, schedule: s };
    } catch (err) {
      logger.error("run-now failed:", err);
      throw err;
    }
  });

  ipcMain.handle(
    "agent-schedules:list-history",
    async (_event, args?: { scheduleId?: string; limit?: number }) => {
      try {
        let result = history.slice().reverse();
        if (args?.scheduleId) {
          result = result.filter((h) => h.scheduleId === args.scheduleId);
        }
        if (args?.limit && args.limit > 0) result = result.slice(0, args.limit);
        return { success: true, history: result };
      } catch (err) {
        logger.error("list-history failed:", err);
        throw err;
      }
    },
  );

  // Reads an audio file written by the voice assistant and returns a
  // data URL the renderer can attach to an <audio> element. Restricted
  // to files we previously produced via TTS to avoid arbitrary FS reads.
  ipcMain.handle(
    "agent-schedules:read-audio",
    async (_event, audioPath: string) => {
      try {
        if (!audioPath || typeof audioPath !== "string") {
          throw new Error("audioPath is required");
        }
        const known = new Set<string>();
        for (const s of schedules.values()) {
          if (s.lastAudioPath) known.add(s.lastAudioPath);
        }
        for (const h of history) {
          if (h.audioPath) known.add(h.audioPath);
        }
        if (!known.has(audioPath)) {
          throw new Error("audioPath not recognized");
        }
        if (!(await fs.pathExists(audioPath))) {
          throw new Error("audio file no longer exists");
        }
        const buf = await fs.readFile(audioPath);
        const ext = path.extname(audioPath).toLowerCase().replace(".", "");
        const mime =
          ext === "mp3"
            ? "audio/mpeg"
            : ext === "wav"
              ? "audio/wav"
              : ext === "ogg"
                ? "audio/ogg"
                : "application/octet-stream";
        return {
          success: true,
          dataUrl: `data:${mime};base64,${buf.toString("base64")}`,
        };
      } catch (err) {
        logger.error("read-audio failed:", err);
        throw err;
      }
    },
  );

  logger.info("Agent Schedule handlers registered");
}
