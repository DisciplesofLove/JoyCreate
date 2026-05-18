/**
 * OpenClaw Agent Bridge — listens to inbound messages from the OpenClaw
 * gateway (Discord / Telegram / Slack / etc. via external connectors) and,
 * if a message begins with `!agent <id-or-slug> <prompt>` (or
 * `/agent <id-or-slug> <prompt>`), dispatches it to the matching
 * agent_builder agent and posts the result back to the originating channel
 * via the gateway's `response:external` event.
 *
 * Wired up from `cns:initialize` so its lifecycle follows the CNS.
 * Idempotent — safe to call `attach` multiple times.
 */

import log from "electron-log";
import type { OpenClawMessage } from "@/types/openclaw_types";
import { getOpenClawGateway } from "./openclaw_gateway_service";
import { dispatchAgent, resolveMention } from "./agent_dispatcher";

const logger = log.scope("openclaw_agent_bridge");

const AGENT_PREFIX = /^\s*!agent\s+/i;

let attached = false;

interface InboundEventPayload {
  clientId: string;
  message: OpenClawMessage;
}

function extractText(message: OpenClawMessage): string | undefined {
  const payload = message.payload;
  if (typeof payload === "string") return payload;
  if (payload && typeof payload === "object") {
    const obj = payload as Record<string, unknown>;
    if (typeof obj.text === "string") return obj.text;
    if (typeof obj.content === "string") return obj.content;
    if (typeof obj.message === "string") return obj.message;
  }
  return undefined;
}

async function handleInbound(payload: InboundEventPayload): Promise<void> {
  const { clientId, message } = payload;
  if (!message || message.type !== "chat") return;
  const text = extractText(message);
  if (!text) return;

  // Two accepted syntaxes:
  //   !agent <id-or-slug> <prompt>
  //   /agent <id-or-slug> <prompt>     (handled by resolveMention)
  let agentTarget: string | undefined;
  let prompt: string | undefined;

  const bangMatch = text.match(/^\s*!agent\s+([A-Za-z0-9_-]+)\s*([\s\S]*)$/i);
  if (bangMatch) {
    agentTarget = bangMatch[1];
    prompt = bangMatch[2].trim();
  } else {
    const mention = resolveMention(text);
    if (mention) {
      agentTarget = mention.agentId;
      prompt = mention.remainingText;
    }
  }
  if (!agentTarget) return;

  const channelId =
    message.to && message.to.id ? message.to.id : message.from.id;

  try {
    const exec = await dispatchAgent({
      agentIdOrSlug: agentTarget,
      input: prompt || "(no prompt)",
      source: "openclaw",
    });
    const replyText =
      typeof exec.output === "string"
        ? exec.output
        : exec.output !== undefined
          ? JSON.stringify(exec.output, null, 2)
          : exec.error
            ? `Agent error: ${exec.error}`
            : "(agent produced no output)";

    const gw = getOpenClawGateway();
    gw.emit("response:external", {
      clientId,
      message: {
        id: `agent-reply-${exec.id}`,
        type: "chat",
        from: { type: "agent", id: exec.agentId },
        to: { type: "broadcast", id: channelId },
        replyTo: message.id,
        payload: {
          text: replyText.slice(0, 4000),
          executionId: exec.id,
          status: exec.status,
        },
        timestamp: Date.now(),
      },
    });
  } catch (err) {
    logger.warn("Agent dispatch failed for OpenClaw inbound:", err);
    try {
      const gw = getOpenClawGateway();
      gw.emit("response:external", {
        clientId,
        message: {
          id: `agent-error-${message.id}`,
          type: "error",
          from: { type: "system", id: "agent-bridge" },
          to: { type: "broadcast", id: channelId },
          replyTo: message.id,
          payload: {
            error:
              err instanceof Error ? err.message : String(err ?? "unknown"),
          },
          timestamp: Date.now(),
        },
      });
    } catch {
      // gateway shutdown — nothing more to do
    }
  }
}

/** Idempotent — attaches the listener once. */
export function attachOpenClawAgentBridge(): void {
  if (attached) return;
  try {
    const gw = getOpenClawGateway();
    gw.on("message:received", (payload: InboundEventPayload) => {
      const text = extractText(payload.message);
      if (!text) return;
      const head = text.trimStart();
      const looksLikeAgentCommand =
        AGENT_PREFIX.test(head) ||
        head.startsWith("/agent") ||
        head.startsWith("@");
      if (!looksLikeAgentCommand) return;
      void handleInbound(payload);
    });
    attached = true;
    logger.info("OpenClaw agent bridge attached");
  } catch (err) {
    logger.warn("Failed to attach OpenClaw agent bridge:", err);
  }
}

/** For tests / hot-reload. */
export function detachOpenClawAgentBridge(): void {
  // We rely on the gateway singleton being torn down to drop the listener;
  // EventEmitter does not give us back a deregistration handle here without
  // refactor. Leaving as a no-op until tests need it.
  attached = false;
}
