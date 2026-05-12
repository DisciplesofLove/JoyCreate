/**
 * Hypercore peer-layer IPC handlers — main-process surface for the
 * {@link HyperService}. Mutating channels go through `guarded()`; read
 * channels are unwrapped invoke handlers.
 */

import { ipcMain, type IpcMainInvokeEvent } from "electron";
import log from "electron-log";
import { guarded } from "@/ipc/utils/guarded_handle";
import { getHyperService } from "@/lib/hyper/hyper_service";
import {
  anchorNow,
  startAnchorScheduler,
  stopAnchorScheduler,
} from "@/lib/hyper/anchor_service";

const logger = log.scope("hyper_handlers");

interface ScopeSubject {
  scope: string;
  subjectId: string;
}

function requireScopeSubject(payload: unknown): ScopeSubject {
  const p = payload as Partial<ScopeSubject> | null;
  if (!p?.scope || typeof p.scope !== "string") {
    throw new Error("requires { scope: string }");
  }
  if (typeof p.subjectId !== "string") {
    throw new Error("requires { subjectId: string }");
  }
  return { scope: p.scope, subjectId: p.subjectId };
}

export function registerHyperHandlers(): void {
  // ── Lifecycle / status ───────────────────────────────────────────────────
  ipcMain.handle(
    "hyper:status",
    async (_event: IpcMainInvokeEvent) => getHyperService().status(),
  );

  ipcMain.handle(
    "hyper:start",
    guarded("hyper:start", async (_event: IpcMainInvokeEvent) => {
      await getHyperService().start();
      startAnchorScheduler();
      return getHyperService().status();
    }),
  );

  ipcMain.handle(
    "hyper:stop",
    guarded("hyper:stop", async (_event: IpcMainInvokeEvent) => {
      stopAnchorScheduler();
      await getHyperService().stop();
      return { ok: true };
    }),
  );

  ipcMain.handle(
    "hyper:anchor:now",
    guarded("hyper:anchor:now", async () => ({ anchored: await anchorNow() })),
  );

  ipcMain.handle("hyper:topics:list", async () =>
    getHyperService().listTopics(),
  );

  ipcMain.handle("hyper:peers:list", async () => getHyperService().listPeers());

  ipcMain.handle(
    "hyper:topics:join",
    guarded(
      "hyper:topics:join",
      async (
        _event: IpcMainInvokeEvent,
      payload: ScopeSubject & { type?: "log" | "bee" | "drive" | "autobase" },
      ) => {
        const { scope, subjectId } = requireScopeSubject(payload);
        const type = payload.type ?? "log";
        const svc = getHyperService();
        if (type === "log") await svc.openLog(scope, subjectId);
        else if (type === "bee") await svc.openBee(scope, subjectId);
        else if (type === "autobase") await svc.openAutobase(scope, subjectId);
        else await svc.openDrive(scope, subjectId);
        return { ok: true };
      },
    ),
  );

  ipcMain.handle(
    "hyper:topics:leave",
    guarded(
      "hyper:topics:leave",
      async (_event: IpcMainInvokeEvent, payload: ScopeSubject) => {
        const { scope, subjectId } = requireScopeSubject(payload);
        await getHyperService().leaveTopic(scope, subjectId);
        return { ok: true };
      },
    ),
  );

  // ── Append-only log (hypercore directly) ─────────────────────────────────
  ipcMain.handle(
    "hyper:core:append",
    guarded(
      "hyper:core:append",
      async (
        _event: IpcMainInvokeEvent,
        payload: ScopeSubject & { entry: unknown },
      ) => {
        const { scope, subjectId } = requireScopeSubject(payload);
        if (payload.entry === undefined) {
          throw new Error("hyper:core:append requires { entry }");
        }
        return getHyperService().appendLog(scope, subjectId, payload.entry);
      },
    ),
  );

  ipcMain.handle(
    "hyper:core:read",
    async (
      _event: IpcMainInvokeEvent,
      payload: ScopeSubject & { start?: number; end?: number },
    ) => {
      const { scope, subjectId } = requireScopeSubject(payload);
      return getHyperService().readLog(scope, subjectId, {
        start: payload.start,
        end: payload.end,
      });
    },
  );

  // ── Hyperbee key/value ───────────────────────────────────────────────────
  ipcMain.handle(
    "hyper:bee:put",
    guarded(
      "hyper:bee:put",
      async (
        _event: IpcMainInvokeEvent,
        payload: ScopeSubject & { key: string; value: unknown },
      ) => {
        const { scope, subjectId } = requireScopeSubject(payload);
        if (typeof payload.key !== "string") {
          throw new Error("hyper:bee:put requires { key: string }");
        }
        await getHyperService().beePut(scope, subjectId, payload.key, payload.value);
        return { ok: true };
      },
    ),
  );

  ipcMain.handle(
    "hyper:bee:get",
    async (
      _event: IpcMainInvokeEvent,
      payload: ScopeSubject & { key: string },
    ) => {
      const { scope, subjectId } = requireScopeSubject(payload);
      if (typeof payload.key !== "string") {
        throw new Error("hyper:bee:get requires { key: string }");
      }
      return getHyperService().beeGet(scope, subjectId, payload.key);
    },
  );

  ipcMain.handle(
    "hyper:bee:list",
    async (
      _event: IpcMainInvokeEvent,
      payload: ScopeSubject & { gte?: string; lt?: string; limit?: number },
    ) => {
      const { scope, subjectId } = requireScopeSubject(payload);
      return getHyperService().beeList(scope, subjectId, {
        gte: payload.gte,
        lt: payload.lt,
        limit: payload.limit,
      });
    },
  );

  // ── Hyperdrive blobs ─────────────────────────────────────────────────────
  ipcMain.handle(
    "hyper:drive:put",
    guarded(
      "hyper:drive:put",
      async (
        _event: IpcMainInvokeEvent,
        payload: ScopeSubject & { path: string; data: string | Uint8Array },
      ) => {
        const { scope, subjectId } = requireScopeSubject(payload);
        if (typeof payload.path !== "string") {
          throw new Error("hyper:drive:put requires { path: string }");
        }
        await getHyperService().drivePut(scope, subjectId, payload.path, payload.data);
        return { ok: true };
      },
    ),
  );

  ipcMain.handle(
    "hyper:drive:get",
    async (
      _event: IpcMainInvokeEvent,
      payload: ScopeSubject & { path: string; encoding?: "utf-8" | "base64" },
    ) => {
      const { scope, subjectId } = requireScopeSubject(payload);
      if (typeof payload.path !== "string") {
        throw new Error("hyper:drive:get requires { path: string }");
      }
      const buf = await getHyperService().driveGet(scope, subjectId, payload.path);
      if (!buf) return null;
      return payload.encoding === "utf-8"
        ? buf.toString("utf-8")
        : buf.toString("base64");
    },
  );

  ipcMain.handle(
    "hyper:drive:list",
    async (
      _event: IpcMainInvokeEvent,
      payload: ScopeSubject & { folder?: string },
    ) => {
      const { scope, subjectId } = requireScopeSubject(payload);
      return getHyperService().driveList(scope, subjectId, payload.folder ?? "/");
    },
  );

  // ── Autobase multi-writer (Phase 4) ──────────────────────────────────────
  ipcMain.handle(
    "hyper:autobase:append",
    guarded(
      "hyper:autobase:append",
      async (
        _event: IpcMainInvokeEvent,
        payload: ScopeSubject & { entry: unknown },
      ) => {
        const { scope, subjectId } = requireScopeSubject(payload);
        if (payload.entry === undefined) {
          throw new Error("hyper:autobase:append requires { entry }");
        }
        return getHyperService().autobaseAppend(scope, subjectId, payload.entry);
      },
    ),
  );

  ipcMain.handle(
    "hyper:autobase:read",
    async (
      _event: IpcMainInvokeEvent,
      payload: ScopeSubject & { start?: number; end?: number },
    ) => {
      const { scope, subjectId } = requireScopeSubject(payload);
      return getHyperService().autobaseRead(scope, subjectId, {
        start: payload.start,
        end: payload.end,
      });
    },
  );

  ipcMain.handle(
    "hyper:autobase:add-writer",
    guarded(
      "hyper:autobase:add-writer",
      async (
        _event: IpcMainInvokeEvent,
        payload: ScopeSubject & { writerKeyHex: string },
      ) => {
        const { scope, subjectId } = requireScopeSubject(payload);
        if (typeof payload.writerKeyHex !== "string") {
          throw new Error("requires { writerKeyHex: string }");
        }
        await getHyperService().addAutobaseWriter(
          scope,
          subjectId,
          payload.writerKeyHex,
        );
        return { ok: true };
      },
    ),
  );

  ipcMain.handle(
    "hyper:autobase:local-key",
    async (_event: IpcMainInvokeEvent, payload: ScopeSubject) => {
      const { scope, subjectId } = requireScopeSubject(payload);
      const writerKeyHex = await getHyperService().getAutobaseLocalKey(
        scope,
        subjectId,
      );
      return { writerKeyHex };
    },
  );

  logger.info("Hypercore IPC handlers registered");
}
