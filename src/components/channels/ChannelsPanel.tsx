/**
 * Chat channel configuration — Discord and Telegram.
 *
 * This is the piece that was missing. The main process has had complete bot
 * services for both platforms for a long time: `discord_bot_service` (discord.js
 * Gateway), `telegram_bot_service` (Bot API long-polling), 14 registered IPC
 * channels, all 14 in the preload allowlist, and typed client methods for every
 * one of them.
 *
 * Not a single line of renderer code called any of it. There was no field to
 * paste a token into and no button to press, so the whole subsystem — including
 * the publish/blueprint/copilot command routing and the autonomous-brain
 * escalation behind it — was unreachable.
 *
 * The owner badge is the other half. JoyCreate and the external OpenClaw daemon
 * can both run a bot, and Telegram allows exactly one poller per token; when
 * they collide the API returns 409 and messages vanish. Showing who owns a
 * channel turns that from a mystery into a fact on screen.
 */

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { toast } from "sonner";
import {
  AlertTriangle,
  CheckCircle2,
  Eye,
  EyeOff,
  Loader2,
  Play,
  Square,
  Server,
} from "lucide-react";

import { IpcClient } from "@/ipc/ipc_client";

type ChannelId = "discord" | "telegram";

interface Ownership {
  owner: "in-process" | "daemon" | "unavailable";
  reason: string;
  daemonAlive: boolean;
}

interface ChannelStatus {
  running?: boolean;
  botUsername?: string;
  ownership?: Ownership;
}

const CHANNELS: Array<{
  id: ChannelId;
  name: string;
  icon: string;
  tokenLabel: string;
  help: string;
}> = [
  {
    id: "discord",
    name: "Discord",
    icon: "🎮",
    tokenLabel: "Bot token",
    help: "From the Discord Developer Portal → your application → Bot → Reset Token. The bot also needs the Message Content intent enabled.",
  },
  {
    id: "telegram",
    name: "Telegram",
    icon: "✈️",
    tokenLabel: "Bot token",
    help: "From @BotFather → /newbot, or /token for an existing bot.",
  },
];

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function OwnerBadge({ status }: { status: ChannelStatus | null }) {
  const ownership = status?.ownership;
  if (!ownership) return null;

  if (ownership.owner === "daemon") {
    return (
      <Badge variant="outline" className="gap-1 text-amber-500 border-amber-500/40">
        <Server className="h-3 w-3" /> OpenClaw daemon
      </Badge>
    );
  }
  if (ownership.owner === "unavailable") {
    return <Badge variant="outline">Not configured</Badge>;
  }
  return (
    <Badge variant="outline" className="gap-1 text-green-500 border-green-500/40">
      JoyCreate
    </Badge>
  );
}

function ChannelCard({ channel }: { channel: (typeof CHANNELS)[number] }) {
  const ipc = IpcClient.getInstance();
  const [token, setToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [status, setStatus] = useState<ChannelStatus | null>(null);
  const [busy, setBusy] = useState<null | "validate" | "save" | "start" | "stop">(null);
  const [identity, setIdentity] = useState<string | null>(null);

  const call = useCallback(
    async <T,>(suffix: string, ...args: unknown[]): Promise<T> => {
      // The typed client has a method per channel per verb; going through
      // `invoke` here keeps this component from needing 14 near-identical
      // branches for two platforms that share an interface.
      return ipc.invoke(`${channel.id}:${suffix}`, ...args) as Promise<T>;
    },
    [channel.id, ipc],
  );

  const refresh = useCallback(async () => {
    try {
      setStatus(await call<ChannelStatus>("status"));
    } catch (err) {
      // A status read failing is worth showing, not swallowing — it usually
      // means the handler is not registered.
      setStatus({ running: false });
      console.warn(`${channel.id}:status failed`, err);
    }
  }, [call, channel.id]);

  useEffect(() => {
    void refresh();
    // Poll while mounted: the bot can stop on its own (revoked token, network),
    // and a stale "running" badge is worse than no badge.
    const t = setInterval(() => void refresh(), 10_000);
    return () => clearInterval(t);
  }, [refresh]);

  const onValidate = async () => {
    if (!token.trim()) {
      toast.error("Enter a token first");
      return;
    }
    setBusy("validate");
    setIdentity(null);
    try {
      const res = await call<{ valid: boolean; bot: Record<string, unknown> }>(
        "validate-token",
        token.trim(),
      );
      const bot = res?.bot as { username?: string; first_name?: string } | undefined;
      const who = bot?.username ?? bot?.first_name ?? "unknown";
      setIdentity(who);
      toast.success(`Token is valid — ${who}`);
    } catch (err) {
      // The platform's own rejection is more useful than anything invented
      // here: it distinguishes a revoked token from a malformed one.
      toast.error(`Token rejected: ${errorMessage(err)}`);
    } finally {
      setBusy(null);
    }
  };

  const onSave = async () => {
    if (!token.trim()) {
      toast.error("Enter a token first");
      return;
    }
    setBusy("save");
    try {
      // `configure` starts the bot when `enabled` is true, so this is save-and-
      // connect rather than save-then-press-start.
      await call("configure", { token: token.trim(), enabled: true });
      toast.success(`${channel.name} configured and connecting`);
      setToken("");
      await refresh();
    } catch (err) {
      toast.error(`Could not configure ${channel.name}: ${errorMessage(err)}`);
    } finally {
      setBusy(null);
    }
  };

  const onStart = async () => {
    setBusy("start");
    try {
      await call("start");
      toast.success(`${channel.name} started`);
      await refresh();
    } catch (err) {
      // The ownership arbiter throws here when the daemon owns the channel.
      // Its message names both ways out, so show it whole.
      toast.error(errorMessage(err), { duration: 12000 });
      await refresh();
    } finally {
      setBusy(null);
    }
  };

  const onStop = async () => {
    setBusy("stop");
    try {
      await call("stop");
      toast.success(`${channel.name} stopped`);
      await refresh();
    } catch (err) {
      toast.error(`Could not stop ${channel.name}: ${errorMessage(err)}`);
    } finally {
      setBusy(null);
    }
  };

  const running = !!status?.running;
  const daemonOwns = status?.ownership?.owner === "daemon";

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              <span aria-hidden>{channel.icon}</span> {channel.name}
              {running ? (
                <Badge className="gap-1 bg-green-500/15 text-green-500 hover:bg-green-500/15">
                  <CheckCircle2 className="h-3 w-3" /> Online
                </Badge>
              ) : (
                <Badge variant="secondary">Offline</Badge>
              )}
            </CardTitle>
            <CardDescription>
              {status?.botUsername
                ? `Connected as ${status.botUsername}`
                : "Not connected"}
            </CardDescription>
          </div>
          <OwnerBadge status={status} />
        </div>
      </CardHeader>

      <CardContent className="space-y-3">
        {daemonOwns && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
            <p className="text-xs text-muted-foreground">
              {status?.ownership?.reason}
            </p>
          </div>
        )}

        <div>
          <Label className="text-xs">{channel.tokenLabel}</Label>
          <div className="mt-1 flex gap-2">
            <div className="relative flex-1">
              <Input
                type={showToken ? "text" : "password"}
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder={running ? "Saved — enter a new token to replace" : "Paste token"}
                className="pr-9"
              />
              <button
                type="button"
                aria-label={showToken ? "Hide token" : "Show token"}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground/60 hover:text-foreground"
                onClick={() => setShowToken((v) => !v)}
              >
                {showToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
            <Button
              variant="outline"
              onClick={() => void onValidate()}
              disabled={busy !== null}
            >
              {busy === "validate" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                "Validate"
              )}
            </Button>
            <Button onClick={() => void onSave()} disabled={busy !== null}>
              {busy === "save" ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save"}
            </Button>
          </div>
          <p className="mt-1 text-[11px] text-muted-foreground">{channel.help}</p>
          {identity && (
            <p className="mt-1 text-[11px] text-green-500">
              Validated as {identity} — not saved yet.
            </p>
          )}
        </div>

        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => void onStart()}
            disabled={busy !== null || running}
          >
            {busy === "start" ? (
              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Play className="mr-1 h-3.5 w-3.5" />
            )}
            Start
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void onStop()}
            disabled={busy !== null || !running}
          >
            {busy === "stop" ? (
              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Square className="mr-1 h-3.5 w-3.5" />
            )}
            Stop
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export function ChannelsPanel() {
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Chat channels</h2>
        <p className="text-sm text-muted-foreground">
          Run JoyCreate as a bot. Once connected, messages route through the same
          command handling as the rest of the app — publishing, blueprints and
          agent actions all work from a chat window.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {CHANNELS.map((c) => (
          <ChannelCard key={c.id} channel={c} />
        ))}
      </div>

      <p className="text-xs text-muted-foreground">
        Channels reconnect automatically when JoyCreate starts. With background
        mode on, closing the window keeps them online.
      </p>
    </div>
  );
}

export default ChannelsPanel;
