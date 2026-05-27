/**
 * Renderer-safe types for autonomous-mode chat plans.
 *
 * The autonomous chat mode emits a `<joy-plan>{json}</joy-plan>` block on the
 * first turn. The parser extracts it, persists via the `chat-plan:upsert` IPC,
 * and then the stream handler drives each phase to completion using the
 * existing Code Studio + MCP tools.
 *
 * Schema is intentionally minimal — phase edits / parallel phases / model
 * pinning are out of scope for v1.
 */

export type ChatPlanPhaseStatus =
  | "pending"
  | "running"
  | "done"
  | "failed"
  | "skipped";

export type ChatPlanStatus =
  | "draft" // plan parsed, not started
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

export interface ChatPlanPhase {
  id: string;
  title: string;
  description?: string;
  status: ChatPlanPhaseStatus;
  /** Optional task list rendered inside the phase. */
  steps?: string[];
  /** ISO timestamp set when phase enters `running`. */
  startedAt?: string;
  /** ISO timestamp set when phase reaches a terminal state. */
  completedAt?: string;
  /** Short post-execution summary written by the model. */
  summary?: string;
  /** Error message if status === "failed". */
  error?: string;
  /** Number of tool calls used during the phase (telemetry). */
  toolCalls?: number;
}

export interface ChatPlan {
  id: number;
  chatId: number;
  goal: string;
  phases: ChatPlanPhase[];
  /** 0-based index into `phases`. -1 when no phase has started. */
  currentPhaseIndex: number;
  status: ChatPlanStatus;
  startedAt?: string;
  completedAt?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

/** Shape the model emits inside `<joy-plan>` — looser than `ChatPlan`. */
export interface ChatPlanDraft {
  goal: string;
  phases: Array<{
    id?: string;
    title: string;
    description?: string;
    steps?: string[];
  }>;
}

/** Per-mode default step caps used when settings don't override. */
export const DEFAULT_MODE_STEP_CAPS = {
  agent: 20,
  autonomous: 60,
  mcp: 30,
  "local-agent": 40,
} as const;
