/**
 * Lightweight one-shot WebSocket RPC client for the running OpenClaw daemon.
 *
 * Used to evict in-flight pollers (e.g. Telegram) without restarting the
 * daemon process. Sends the v3 connect frame, then a single method call,
 * waits for the response, and closes.
 *
 * Reads auth token + port from `~/.openclaw/openclaw.json` (gateway.auth.token,
 * gateway.daemonPort), with sane fallbacks.
 */

import WebSocket from "ws";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { v4 as uuidv4 } from "uuid";
import log from "electron-log";

const logger = log.scope("openclaw-daemon-rpc");

interface DaemonRpcOptions {
  /** Override the daemon port (default: read from config or 18790) */
  port?: number;
  /** Override the host (default: 127.0.0.1) */
  host?: string;
  /** Override the auth token (default: read from daemon config) */
  token?: string;
  /** Connection + response timeout in ms (default: 4000) */
  timeoutMs?: number;
}

interface DaemonRpcResult {
  ok: boolean;
  result?: unknown;
  error?: { code?: string; message?: string };
}

function readDaemonConfig(): { token: string; port: number } {
  try {
    const cfgPath = join(homedir(), ".openclaw", "openclaw.json");
    if (!existsSync(cfgPath)) return { token: "", port: 18790 };
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8").replace(/^\uFEFF/, ""));
    return {
      token: cfg?.gateway?.auth?.token ?? "",
      port: cfg?.gateway?.port ?? 18790,
    };
  } catch {
    return { token: "", port: 18790 };
  }
}

/**
 * Send a single RPC method to the live daemon over WS. Resolves with the
 * decoded `respond()` payload from the daemon. Never throws — failures are
 * returned as `{ ok: false, error }`.
 */
export async function callDaemonMethod(
  method: string,
  params: Record<string, unknown> = {},
  options: DaemonRpcOptions = {},
): Promise<DaemonRpcResult> {
  const cfg = readDaemonConfig();
  const port = options.port ?? cfg.port;
  const host = options.host ?? "127.0.0.1";
  const token = options.token ?? cfg.token;
  const timeoutMs = options.timeoutMs ?? 4000;
  const url = `ws://${host}:${port}`;

  return new Promise((resolve) => {
    let settled = false;
    const finish = (r: DaemonRpcResult) => {
      if (settled) return;
      settled = true;
      try { ws.close(1000, "rpc done"); } catch { /* ignore */ }
      resolve(r);
    };

    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      resolve({
        ok: false,
        error: { code: "WS_CONSTRUCT_FAILED", message: (err as Error).message },
      });
      return;
    }

    const timer = setTimeout(() => {
      try { ws.terminate(); } catch { /* ignore */ }
      finish({ ok: false, error: { code: "TIMEOUT", message: `no response within ${timeoutMs}ms` } });
    }, timeoutMs);

    const connectId = uuidv4();
    const callId = uuidv4();

    ws.on("open", () => {
      const connectFrame = {
        type: "req",
        method: "connect",
        id: connectId,
        params: {
          client: {
            id: "gateway-client",
            displayName: "JoyCreate (one-shot rpc)",
            mode: "backend",
            version: "rpc",
            platform: "electron",
          },
          ...(token ? { auth: { token } } : {}),
          minProtocol: 3,
          maxProtocol: 3,
          role: "operator",
          scopes: ["operator.admin"],
        },
      };
      try {
        ws.send(JSON.stringify(connectFrame));
      } catch (err) {
        clearTimeout(timer);
        finish({ ok: false, error: { code: "SEND_FAILED", message: (err as Error).message } });
      }
    });

    let connected = false;
    ws.on("message", (data: Buffer | string) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      const msgId = msg.id;
      if (!connected && msgId === connectId) {
        if (msg.ok === false || msg.error) {
          clearTimeout(timer);
          finish({ ok: false, error: (msg.error as DaemonRpcResult["error"]) ?? { code: "CONNECT_REJECTED" } });
          return;
        }
        connected = true;
        // Send the actual call now
        try {
          ws.send(JSON.stringify({ type: "req", method, id: callId, params }));
        } catch (err) {
          clearTimeout(timer);
          finish({ ok: false, error: { code: "SEND_FAILED", message: (err as Error).message } });
        }
        return;
      }
      if (connected && msgId === callId) {
        clearTimeout(timer);
        if (msg.ok === false || msg.error) {
          finish({ ok: false, error: (msg.error as DaemonRpcResult["error"]) ?? { code: "RPC_ERROR" } });
        } else {
          finish({ ok: true, result: msg.result });
        }
      }
    });

    ws.on("error", (err) => {
      clearTimeout(timer);
      finish({ ok: false, error: { code: "WS_ERROR", message: (err as Error).message } });
    });

    ws.on("close", (code, reason) => {
      if (!settled) {
        clearTimeout(timer);
        finish({
          ok: false,
          error: {
            code: "CLOSED",
            message: `closed (${code}) ${reason?.toString() || ""}`.trim(),
          },
        });
      }
    });
  });
}

/**
 * Stop a channel (e.g. "telegram") on the running daemon without restarting it.
 * Frees the bot token immediately so JoyCreate's local poller can take over.
 *
 * Idempotent: safe to call even if the channel is already stopped.
 */
export async function stopDaemonChannel(
  channel: string,
  accountId?: string,
): Promise<DaemonRpcResult> {
  const params: Record<string, unknown> = { channel };
  if (accountId) params.accountId = accountId;
  const r = await callDaemonMethod("channels.stop", params);
  if (r.ok) {
    logger.info(`Daemon channel "${channel}" stopped via WS RPC`);
  } else {
    logger.warn(
      `Daemon channels.stop "${channel}" failed: ${r.error?.code ?? ""} ${r.error?.message ?? ""}`,
    );
  }
  return r;
}
