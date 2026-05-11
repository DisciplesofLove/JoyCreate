/**
 * Whitehat MCP IPC handlers — surface the sandbox policy state to the
 * renderer (allowlist CRUD, audit log, live pending approvals).
 *
 * Mutating channels go through Neural Guard via `guarded()`. Read channels
 * are unwrapped invoke handlers.
 */

import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from "electron";
import log from "electron-log";
import { guarded } from "@/ipc/utils/guarded_handle";
import {
  evaluate,
  listAllowlist,
  listAudit,
  listPending,
  onPending,
  respondPending,
  revokeAllowlist,
  setInteractiveAvailability,
  type ApprovalChoice,
  type PendingApproval,
} from "@/lib/mcp_sandbox/policy";
import { computeInvocationHash } from "@/lib/mcp_sandbox/hash";

const logger = log.scope("whitehat_mcp_handlers");

export function registerWhitehatMcpHandlers(): void {
  // Hybrid mode: only prompt the user when JoyCreate is foregrounded.
  setInteractiveAvailability(() => {
    const focused = BrowserWindow.getFocusedWindow();
    return focused != null && !focused.isDestroyed();
  });

  // Forward every new pending approval to all renderer windows.
  onPending((entry: PendingApproval) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send("whitehat:mcp:pending", entry);
      }
    }
  });

  ipcMain.handle("whitehat:mcp:list-pending", async () => listPending());

  ipcMain.handle("whitehat:mcp:list-allowlist", async () => listAllowlist());

  ipcMain.handle(
    "whitehat:mcp:list-audit",
    async (_event: IpcMainInvokeEvent, limit?: number) =>
      listAudit(typeof limit === "number" ? limit : 100),
  );

  ipcMain.handle(
    "whitehat:mcp:hash",
    async (
      _event: IpcMainInvokeEvent,
      payload: { serverName: string; toolName: string; args: unknown },
    ) => {
      if (!payload?.serverName || !payload?.toolName) {
        throw new Error("whitehat:mcp:hash requires { serverName, toolName }");
      }
      return computeInvocationHash({
        serverName: payload.serverName,
        toolName: payload.toolName,
        args: payload.args ?? null,
      });
    },
  );

  ipcMain.handle(
    "whitehat:mcp:respond",
    guarded(
      "whitehat:mcp:respond",
      async (
        _event: IpcMainInvokeEvent,
        payload: { id: number; choice: ApprovalChoice },
      ) => {
        if (typeof payload?.id !== "number" || !payload?.choice) {
          throw new Error(
            "whitehat:mcp:respond requires { id: number, choice }",
          );
        }
        if (
          payload.choice !== "once" &&
          payload.choice !== "always" &&
          payload.choice !== "deny"
        ) {
          throw new Error(`unknown choice "${payload.choice}"`);
        }
        const ok = respondPending(payload.id, payload.choice);
        if (!ok) throw new Error(`pending approval ${payload.id} not found`);
        return { ok: true };
      },
    ),
  );

  ipcMain.handle(
    "whitehat:mcp:revoke",
    guarded(
      "whitehat:mcp:revoke",
      async (_event: IpcMainInvokeEvent, payload: { id: number }) => {
        if (typeof payload?.id !== "number") {
          throw new Error("whitehat:mcp:revoke requires { id: number }");
        }
        await revokeAllowlist(payload.id);
        return { ok: true };
      },
    ),
  );

  ipcMain.handle(
    "whitehat:mcp:simulate",
    guarded(
      "whitehat:mcp:simulate",
      async (
        _event: IpcMainInvokeEvent,
        payload: { serverName: string; toolName: string; args: unknown },
      ) => {
        if (!payload?.serverName || !payload?.toolName) {
          throw new Error(
            "whitehat:mcp:simulate requires { serverName, toolName }",
          );
        }
        return evaluate(
          {
            serverName: payload.serverName,
            toolName: payload.toolName,
            args: payload.args ?? null,
          },
          null,
        );
      },
    ),
  );

  logger.info("whitehat MCP handlers registered");
}
