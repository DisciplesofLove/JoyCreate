/**
 * Who owns a messaging channel — JoyCreate, or the external OpenClaw daemon?
 *
 * This exists because of a bug that has already happened. The daemon at
 * `~/.openclaw` runs its own Telegram and Discord bots. Telegram's Bot API
 * allows exactly **one** `getUpdates` poller per token, so when JoyCreate's
 * in-process bot starts on a token the daemon is already polling, both sides
 * lose. The daemon's own error log records it:
 *
 *   409: Conflict: terminated by other getUpdates request; make sure that only
 *   one bot instance is running. Another OpenClaw gateway, script, or Telegram
 *   poller may be using this bot token.
 *
 * The symptom — messages silently dropped or arriving erratically — is nowhere
 * near the cause, which is why this is a deliberate, tested decision rather
 * than a comment telling people to be careful. Discord tolerates two Gateway
 * sessions better than Telegram tolerates two pollers, but two bots answering
 * the same message is its own bug, so the rule is uniform across channels.
 *
 * Every `*:start` handler asks this first and throws the reason instead of
 * starting a second owner.
 */

import path from "node:path";
import fs from "node:fs";
import { app } from "electron";
import log from "electron-log";

import { getOpenClawGateway } from "@/lib/openclaw_gateway_service";
import { readSettings } from "@/main/settings";

const logger = log.scope("channel-owner");

export type ChannelName = "discord" | "telegram" | "slack";

export type ChannelOwner =
  /** JoyCreate may run this channel itself. */
  | "in-process"
  /** The external daemon is running it; JoyCreate must not compete. */
  | "daemon"
  /** Nobody can run it — usually no credentials. */
  | "unavailable";

export interface OwnershipDecision {
  channel: ChannelName;
  owner: ChannelOwner;
  /** Plain-language reason, shown in the UI and used as the throw message. */
  reason: string;
  /** Whether the daemon was reachable when this was decided. */
  daemonAlive: boolean;
}

/** Credential fields that count as "this channel is configured", per channel. */
const CREDENTIAL_KEYS: Record<ChannelName, string[]> = {
  discord: ["token"],
  telegram: ["botToken", "token"],
  slack: ["botToken", "appToken"],
};

function daemonConfigPath(): string {
  return path.join(app.getPath("home"), ".openclaw", "openclaw.json");
}

/**
 * The user's explicit choice of owner for a channel, if the app has a setting
 * for it. Only Telegram has one today (`telegramOwner`, default "local").
 *
 * Read defensively: settings are user-editable JSON, and an unreadable settings
 * file must not decide channel ownership.
 */
function preferredOwner(channel: ChannelName): "local" | "daemon" | undefined {
  if (channel !== "telegram") return undefined;
  try {
    return readSettings().telegramOwner ?? "local";
  } catch {
    // Default matches `tryAutoStartTelegramBot`: JoyCreate owns Telegram.
    return "local";
  }
}

/**
 * The daemon's view of a channel, read from its own config file.
 *
 * Returns `null` when the file cannot be read or parsed. That is deliberately
 * not an error: a missing or corrupt daemon config must not stop JoyCreate from
 * running its own bot, so the caller treats `null` as "the daemon claims
 * nothing".
 */
export function readDaemonChannel(
  channel: ChannelName,
): { enabled: boolean; hasCredential: boolean } | null {
  try {
    const raw = fs.readFileSync(daemonConfigPath(), "utf8");
    const cfg = JSON.parse(raw) as {
      channels?: Record<string, Record<string, unknown>>;
    };
    const ch = cfg.channels?.[channel];
    if (!ch) return null;

    const hasCredential = CREDENTIAL_KEYS[channel].some((k) => {
      const v = ch[k];
      return typeof v === "string" && v.trim().length > 0;
    });

    // `enabled` defaults to true when the key is absent, matching how the
    // daemon's own config hardening treats it.
    return { enabled: ch.enabled !== false, hasCredential };
  } catch {
    return null;
  }
}

export interface ResolveOptions {
  /** Does JoyCreate itself hold a credential for this channel? */
  hasLocalCredential: boolean;
}

/**
 * Decide who may run a channel.
 *
 * Order matters: the daemon is checked first, because the whole point is to not
 * start a second poller on a token something else already owns.
 */
export async function resolveOwner(
  channel: ChannelName,
  options: ResolveOptions,
): Promise<OwnershipDecision> {
  let daemonAlive = false;
  try {
    daemonAlive = await getOpenClawGateway().isDaemonAlive();
  } catch (err) {
    // A probe that throws is not evidence the daemon is running. Treating it as
    // alive would block JoyCreate's own bot for no reason.
    logger.warn(`daemon probe failed for ${channel}; assuming not running:`, err);
    daemonAlive = false;
  }

  // An explicit user preference outranks the daemon.
  //
  // `telegramOwner` (default "local") is not just a flag: when it is "local",
  // `tryAutoStartTelegramBot` actively evicts the daemon — it patches
  // ~/.openclaw/openclaw.json to disable the channel across restarts and tells
  // the running daemon to stop polling over WS RPC, freeing the token. If this
  // function reported "daemon" in that case, `telegram:start` would refuse a
  // channel that autostart happily takes, and the UI would contradict the app's
  // own behaviour.
  if (channel === "telegram" && preferredOwner(channel) === "local") {
    return {
      channel,
      owner: options.hasLocalCredential ? "in-process" : "unavailable",
      reason: options.hasLocalCredential
        ? "JoyCreate is set as the Telegram owner; the daemon's poller is stopped when it starts."
        : "No telegram credentials configured in JoyCreate.",
      daemonAlive,
    };
  }

  if (daemonAlive) {
    const claim = readDaemonChannel(channel);
    if (claim?.enabled && claim.hasCredential) {
      return {
        channel,
        owner: "daemon",
        reason:
          `The OpenClaw daemon is running and owns ${channel}. Starting a second ` +
          `${channel} client on the same token would make both drop messages — ` +
          `stop the daemon, or disable ${channel} in ~/.openclaw/openclaw.json.`,
        daemonAlive,
      };
    }
  }

  if (options.hasLocalCredential) {
    return {
      channel,
      owner: "in-process",
      reason: daemonAlive
        ? `The daemon is running but does not own ${channel}; JoyCreate will run it.`
        : `JoyCreate will run ${channel}.`,
      daemonAlive,
    };
  }

  return {
    channel,
    owner: "unavailable",
    reason: `No ${channel} credentials configured in JoyCreate.`,
    daemonAlive,
  };
}

/**
 * Throw unless JoyCreate may start this channel itself.
 *
 * Handlers call this at the top of `*:start`. Throwing rather than returning
 * `{ success: false }` is the repo convention and matters here: a soft failure
 * would let the UI show "started" for a bot that is not running.
 */
export async function assertMayStart(
  channel: ChannelName,
  options: ResolveOptions,
): Promise<OwnershipDecision> {
  const decision = await resolveOwner(channel, options);
  if (decision.owner !== "in-process") {
    throw new Error(decision.reason);
  }
  return decision;
}
