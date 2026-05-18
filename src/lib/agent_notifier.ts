/**
 * Agent Notifier — fans out agent run results to the surfaces the user
 * has opted in to (Joy Assistant inbox + OpenClaw channel). Used by the
 * scheduled-run loop and by manual "Run now" invocations.
 *
 * Both delivery paths are best-effort: a failure in one channel is logged
 * but never propagated, so a notification glitch can't fail an agent run.
 */

import log from "electron-log";

const logger = log.scope("agent_notifier");

export interface AgentNotificationTargets {
  /** If true, post a system message into the user's active Joy Assistant session. */
  joyAssistant?: boolean;
  /**
   * If set, broadcast the result to the named OpenClaw channel
   * (e.g. a Discord channel or Telegram chat).
   */
  openclaw?: {
    clientId: string;
    channelId: string;
  };
}

export interface AgentRunSummary {
  executionId: string;
  agentId: string;
  agentName: string;
  status: "completed" | "failed";
  source: string;
  preview: string;
  error?: string;
  startedAt: Date;
  completedAt?: Date;
  audioPath?: string;
}

/** Build the human-readable body shared across delivery paths. */
function formatBody(summary: AgentRunSummary): string {
  const head =
    summary.status === "completed"
      ? `✅ ${summary.agentName} finished a ${summary.source} run.`
      : `⚠️ ${summary.agentName} ${summary.source} run failed.`;
  const body = summary.error ? summary.error : summary.preview;
  return `${head}\n\n${body || "(no output)"}`.slice(0, 4000);
}

/** Post a notice into the active Joy Assistant session, if any. */
async function notifyJoyAssistant(summary: AgentRunSummary): Promise<void> {
  try {
    const { pushSystemMessage } = await import("./joy_assistant_service");
    pushSystemMessage({
      content: formatBody(summary),
      meta: {
        kind: "agent-run",
        agentId: summary.agentId,
        agentName: summary.agentName,
        executionId: summary.executionId,
        status: summary.status,
        source: summary.source,
        audioPath: summary.audioPath,
      },
    });
  } catch (err) {
    logger.warn("Joy Assistant notification failed:", err);
  }
}

/** Broadcast a notice to a specific OpenClaw channel. */
async function notifyOpenClaw(
  summary: AgentRunSummary,
  target: NonNullable<AgentNotificationTargets["openclaw"]>,
): Promise<void> {
  try {
    const { getOpenClawGateway } = await import("./openclaw_gateway_service");
    const gw = getOpenClawGateway();
    if (!gw || typeof gw.emit !== "function") {
      logger.debug("OpenClaw gateway not initialised; skipping notice");
      return;
    }
    gw.emit("response:external", {
      clientId: target.clientId,
      message: {
        id: `agent-notice-${summary.executionId}`,
        type: "chat",
        from: { type: "agent", id: summary.agentId, name: summary.agentName },
        to: { type: "broadcast", id: target.channelId },
        payload: {
          text: formatBody(summary),
          status: summary.status,
          executionId: summary.executionId,
          source: summary.source,
        },
        timestamp: Date.now(),
      },
    });
  } catch (err) {
    logger.warn("OpenClaw notification failed:", err);
  }
}

/** Fan-out helper invoked after an agent run completes. */
export async function notifyAgentRun(
  summary: AgentRunSummary,
  targets: AgentNotificationTargets | undefined,
): Promise<void> {
  if (!targets) return;
  const jobs: Promise<void>[] = [];
  if (targets.joyAssistant) jobs.push(notifyJoyAssistant(summary));
  if (targets.openclaw) jobs.push(notifyOpenClaw(summary, targets.openclaw));
  if (jobs.length > 0) await Promise.allSettled(jobs);
}
