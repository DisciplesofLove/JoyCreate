/**
 * IPC handlers for autonomous-mode chat plans.
 *
 * Channels:
 *   - `chat-plan:get`           — read plan for chatId (or null)
 *   - `chat-plan:upsert`        — create or replace plan from parsed draft
 *   - `chat-plan:update-phase`  — patch a single phase (status, summary, etc.)
 *   - `chat-plan:reset`         — delete plan for chatId
 *   - `chat:set-mode`           — persist `chats.chatMode`
 *
 * Handlers throw on error (no `{ success: false }` payloads).
 */

import log from "electron-log";
import { db } from "../../db";
import { chats, chatPlans } from "../../db/schema";
import { eq } from "drizzle-orm";
import type {
  ChatPlan,
  ChatPlanPhase,
  ChatPlanStatus,
} from "@/shared/chat_plan_types";
import { ChatModeSchema } from "@/lib/schemas";
import { createLoggedHandler } from "./safe_handle";

const logger = log.scope("chat_plan_handlers");
const handle = createLoggedHandler(logger);

function rowToChatPlan(row: typeof chatPlans.$inferSelect): ChatPlan {
  return {
    id: row.id,
    chatId: row.chatId,
    goal: row.goal,
    phases: row.phases ?? [],
    currentPhaseIndex: row.currentPhaseIndex,
    status: row.status,
    startedAt: row.startedAt ? row.startedAt.toISOString() : undefined,
    completedAt: row.completedAt ? row.completedAt.toISOString() : undefined,
    lastError: row.lastError ?? undefined,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function getPlanByChatId(chatId: number): Promise<ChatPlan | null> {
  const row = await db.query.chatPlans.findFirst({
    where: eq(chatPlans.chatId, chatId),
  });
  return row ? rowToChatPlan(row) : null;
}

export async function upsertChatPlan(params: {
  chatId: number;
  goal: string;
  phases: ChatPlanPhase[];
}): Promise<ChatPlan> {
  const { chatId, goal, phases } = params;
  if (!chatId) throw new Error("chatId is required");
  if (!goal?.trim()) throw new Error("goal is required");
  if (!Array.isArray(phases) || phases.length === 0) {
    throw new Error("at least one phase is required");
  }

  const now = new Date();
  const existing = await db.query.chatPlans.findFirst({
    where: eq(chatPlans.chatId, chatId),
  });

  if (existing) {
    await db
      .update(chatPlans)
      .set({
        goal,
        phases,
        currentPhaseIndex: -1,
        status: "draft",
        startedAt: null,
        completedAt: null,
        lastError: null,
        updatedAt: now,
      })
      .where(eq(chatPlans.id, existing.id));
  } else {
    await db.insert(chatPlans).values({
      chatId,
      goal,
      phases,
      currentPhaseIndex: -1,
      status: "draft",
      createdAt: now,
      updatedAt: now,
    });
  }

  const plan = await getPlanByChatId(chatId);
  if (!plan) throw new Error("failed to upsert chat plan");
  return plan;
}

export async function updateChatPlanPhase(params: {
  chatId: number;
  phaseId: string;
  patch: Partial<ChatPlanPhase>;
  planStatus?: ChatPlanStatus;
  currentPhaseIndex?: number;
  lastError?: string | null;
}): Promise<ChatPlan> {
  const { chatId, phaseId, patch } = params;
  const existing = await db.query.chatPlans.findFirst({
    where: eq(chatPlans.chatId, chatId),
  });
  if (!existing) throw new Error(`No plan for chatId=${chatId}`);

  const phases = (existing.phases ?? []).map((p) =>
    p.id === phaseId ? { ...p, ...patch } : p,
  );

  const updates: Partial<typeof chatPlans.$inferInsert> = {
    phases,
    updatedAt: new Date(),
  };
  if (params.planStatus) updates.status = params.planStatus;
  if (typeof params.currentPhaseIndex === "number") {
    updates.currentPhaseIndex = params.currentPhaseIndex;
  }
  if (params.lastError !== undefined) updates.lastError = params.lastError;
  if (params.planStatus === "running" && !existing.startedAt) {
    updates.startedAt = new Date();
  }
  if (
    params.planStatus === "completed" ||
    params.planStatus === "failed" ||
    params.planStatus === "cancelled"
  ) {
    updates.completedAt = new Date();
  }

  await db.update(chatPlans).set(updates).where(eq(chatPlans.id, existing.id));

  const plan = await getPlanByChatId(chatId);
  if (!plan) throw new Error("failed to update chat plan");
  return plan;
}

/**
 * Apply a `<joy-phase-complete>` tag emitted by the model at the end of a
 * phase-execution turn. Marks the phase done/failed/skipped, advances the
 * plan's `currentPhaseIndex`, and flips overall status to `completed` when
 * all phases reach a terminal state.
 */
export async function applyPhaseCompleteToPlan(params: {
  chatId: number;
  phaseId: string;
  status: "done" | "failed" | "skipped";
  summary?: string;
  error?: string;
}): Promise<ChatPlan> {
  const { chatId, phaseId, status, summary, error } = params;
  const existing = await db.query.chatPlans.findFirst({
    where: eq(chatPlans.chatId, chatId),
  });
  if (!existing) throw new Error(`No plan for chatId=${chatId}`);

  const now = new Date();
  const phases = (existing.phases ?? []).map((p) =>
    p.id === phaseId
      ? {
          ...p,
          status,
          summary: summary ?? p.summary,
          error: status === "failed" ? (error ?? p.error) : undefined,
          completedAt: now.toISOString(),
        }
      : p,
  );

  const completedIndex = phases.findIndex((p) => p.id === phaseId);
  const allTerminal = phases.every(
    (p) =>
      p.status === "done" || p.status === "skipped" || p.status === "failed",
  );
  const anyFailed = phases.some((p) => p.status === "failed");

  const planStatus: ChatPlanStatus = allTerminal
    ? anyFailed
      ? "failed"
      : "completed"
    : status === "failed"
      ? "paused"
      : "running";

  const updates: Partial<typeof chatPlans.$inferInsert> = {
    phases,
    status: planStatus,
    currentPhaseIndex: completedIndex,
    updatedAt: now,
  };
  if (allTerminal) updates.completedAt = now;
  if (status === "failed" && error) updates.lastError = error;

  await db.update(chatPlans).set(updates).where(eq(chatPlans.id, existing.id));

  const plan = await getPlanByChatId(chatId);
  if (!plan) throw new Error("failed to apply phase-complete");
  return plan;
}

/**
 * Flip the first `pending` phase to `running` and return it together with
 * the prompt the renderer should send to the chat stream to drive execution.
 * Returns `null` when no pending phase remains (plan is done).
 */
export async function startNextPlanPhase(params: {
  chatId: number;
}): Promise<{
  phase: ChatPlanPhase;
  prompt: string;
} | null> {
  const { chatId } = params;
  if (!chatId) throw new Error("chatId is required");
  const existing = await db.query.chatPlans.findFirst({
    where: eq(chatPlans.chatId, chatId),
  });
  if (!existing) throw new Error(`No plan for chatId=${chatId}`);

  const phases = existing.phases ?? [];
  const nextIdx = phases.findIndex((p) => p.status === "pending");
  if (nextIdx < 0) return null;

  const now = new Date();
  const updatedPhase: ChatPlanPhase = {
    ...phases[nextIdx],
    status: "running",
    startedAt: now.toISOString(),
    error: undefined,
  };
  const newPhases = phases.map((p, i) => (i === nextIdx ? updatedPhase : p));

  await db
    .update(chatPlans)
    .set({
      phases: newPhases,
      status: "running",
      currentPhaseIndex: nextIdx,
      startedAt: existing.startedAt ?? now,
      lastError: null,
      updatedAt: now,
    })
    .where(eq(chatPlans.id, existing.id));

  const stepLines =
    updatedPhase.steps && updatedPhase.steps.length > 0
      ? `\n\nSteps:\n${updatedPhase.steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}`
      : "";
  const prompt = `Start phase: ${updatedPhase.id} — ${updatedPhase.title}${
    updatedPhase.description ? `\n\n${updatedPhase.description}` : ""
  }${stepLines}\n\nExecute this phase end-to-end, then close the turn with the required \`<joy-phase-complete/>\` tag.`;

  return { phase: updatedPhase, prompt };
}

export function registerChatPlanHandlers() {
  handle(
    "chat-plan:get",
    async (_event, params: { chatId: number }): Promise<ChatPlan | null> => {
      if (!params?.chatId) throw new Error("chatId is required");
      return getPlanByChatId(params.chatId);
    },
  );

  handle(
    "chat-plan:upsert",
    async (
      _event,
      params: { chatId: number; goal: string; phases: ChatPlanPhase[] },
    ): Promise<ChatPlan> => upsertChatPlan(params),
  );

  handle(
    "chat-plan:update-phase",
    async (
      _event,
      params: {
        chatId: number;
        phaseId: string;
        patch: Partial<ChatPlanPhase>;
        planStatus?: ChatPlanStatus;
        currentPhaseIndex?: number;
        lastError?: string | null;
      },
    ): Promise<ChatPlan> => updateChatPlanPhase(params),
  );

  handle(
    "chat-plan:reset",
    async (_event, params: { chatId: number }): Promise<void> => {
      if (!params?.chatId) throw new Error("chatId is required");
      await db.delete(chatPlans).where(eq(chatPlans.chatId, params.chatId));
    },
  );

  handle(
    "chat-plan:start-next",
    async (
      _event,
      params: { chatId: number },
    ): Promise<{ phase: ChatPlanPhase; prompt: string } | null> => {
      if (!params?.chatId) throw new Error("chatId is required");
      return startNextPlanPhase({ chatId: params.chatId });
    },
  );

  handle(
    "chat:set-mode",
    async (
      _event,
      params: { chatId: number; mode: string | null },
    ): Promise<void> => {
      if (!params?.chatId) throw new Error("chatId is required");
      let mode: string | null = null;
      if (params.mode != null) {
        const parsed = ChatModeSchema.safeParse(params.mode);
        if (!parsed.success) {
          throw new Error(`Invalid chat mode: ${params.mode}`);
        }
        mode = parsed.data;
      }
      await db
        .update(chats)
        .set({ chatMode: mode })
        .where(eq(chats.id, params.chatId));
    },
  );
}
