/**
 * Left Gauntlet IPC handlers — exposes the GauntletService to the renderer.
 *
 * Mutations are wrapped in `guarded()` so Neural Guard validates the signed
 * intent envelope. Reads are bare invoke handlers. Failures throw.
 */

import {
  BrowserWindow,
  ipcMain,
  type IpcMainInvokeEvent,
} from "electron";
import log from "electron-log";
import { desc, eq } from "drizzle-orm";
import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import { guarded } from "@/ipc/utils/guarded_handle";
import { getDb } from "@/db";
import { gauntletAudit, gauntletRuns, gauntletSessions } from "@/db/schema";
import { browserPool } from "@/lib/gauntlet/browser_pool";
import {
  cancelRun,
  executeGauntletRun,
} from "@/lib/gauntlet/gauntlet_service";
import { pingFirecrawl } from "@/lib/gauntlet/firecrawl_client";
import {
  pingOllama,
  verifyMarkdown,
} from "@/lib/gauntlet/whitehat_verifier";
import { saveCookieJar, deleteCookieJar } from "@/lib/gauntlet/session_vault";
import type {
  GauntletProgressEvent,
  GauntletRunInput,
  GauntletSessionMeta,
} from "@/lib/gauntlet/types";

const logger = log.scope("gauntlet_handlers");

function broadcast(event: GauntletProgressEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send("gauntlet:progress", event);
    }
  }
}

export function registerGauntletHandlers(): void {
  // ── gauntlet:run (async kick-off) ─────────────────────────────────────
  ipcMain.handle(
    "gauntlet:run",
    guarded(
      "gauntlet:run",
      async (_event: IpcMainInvokeEvent, payload: GauntletRunInput) => {
        if (!payload || typeof payload.targetUrl !== "string") {
          throw new Error("gauntlet:run requires { targetUrl }");
        }
        if (typeof payload.intentText !== "string" || !payload.intentText) {
          throw new Error("gauntlet:run requires non-empty intentText");
        }
        // Fire and forget — the caller is expected to subscribe to
        // "gauntlet:progress" + poll list-runs / get-run for the result.
        // We still return the runId-bearing summary if the caller awaits.
        return executeGauntletRun(payload, broadcast);
      },
    ),
  );

  // ── gauntlet:cancel ──────────────────────────────────────────────────
  ipcMain.handle(
    "gauntlet:cancel",
    guarded(
      "gauntlet:cancel",
      async (_event: IpcMainInvokeEvent, payload: { runId: string }) => {
        if (!payload?.runId) {
          throw new Error("gauntlet:cancel requires { runId }");
        }
        const ok = cancelRun(payload.runId);
        if (!ok) throw new Error(`run ${payload.runId} not active`);
        return { ok: true };
      },
    ),
  );

  // ── gauntlet:list-runs ───────────────────────────────────────────────
  ipcMain.handle(
    "gauntlet:list-runs",
    async (_event: IpcMainInvokeEvent, limit?: number) => {
      const db = await getDb();
      const lim =
        typeof limit === "number" && limit > 0 && limit <= 500 ? limit : 100;
      return db
        .select()
        .from(gauntletRuns)
        .orderBy(desc(gauntletRuns.id))
        .limit(lim);
    },
  );

  // ── gauntlet:get-run ─────────────────────────────────────────────────
  ipcMain.handle(
    "gauntlet:get-run",
    async (_event: IpcMainInvokeEvent, runId: string) => {
      if (!runId) throw new Error("gauntlet:get-run requires runId");
      const db = await getDb();
      const [row] = await db
        .select()
        .from(gauntletRuns)
        .where(eq(gauntletRuns.runId, runId));
      if (!row) return null;
      let markdown: string | null = null;
      if (row.markdownPath) {
        try {
          markdown = await fs.readFile(row.markdownPath, "utf8");
        } catch (err) {
          logger.warn("markdown read failed", err);
        }
      }
      const audit = await db
        .select()
        .from(gauntletAudit)
        .where(eq(gauntletAudit.runId, runId))
        .orderBy(gauntletAudit.id);
      return { ...row, markdown, audit };
    },
  );

  // ── gauntlet:list-sessions ───────────────────────────────────────────
  ipcMain.handle("gauntlet:list-sessions", async () => {
    const db = await getDb();
    return db
      .select()
      .from(gauntletSessions)
      .orderBy(desc(gauntletSessions.lastUsedAt));
  });

  // ── gauntlet:create-session (opens login window, captures cookies) ──
  ipcMain.handle(
    "gauntlet:create-session",
    guarded(
      "gauntlet:create-session",
      async (
        _event: IpcMainInvokeEvent,
        payload: {
          label: string;
          originPattern: string;
          loginUrl: string;
        },
      ) => {
        if (!payload?.label || !payload?.originPattern || !payload?.loginUrl) {
          throw new Error(
            "gauntlet:create-session requires { label, originPattern, loginUrl }",
          );
        }
        const id = `ses_${Date.now().toString(36)}_${crypto
          .randomBytes(3)
          .toString("hex")}`;
        const slot = await browserPool.acquire(id, { visible: true });
        await slot.window.loadURL(payload.loginUrl);

        // Wait for the user to close the window (they finish logging in
        // and either close the window or click a "Done" external trigger).
        await new Promise<void>((resolve) => {
          slot.window.on("closed", () => resolve());
        });

        try {
          // Window is gone but its session partition persists; pull cookies
          // from the partition directly.
          const ses = (await import("electron")).session.fromPartition(
            slot.partition,
          );
          const cookies = await ses.cookies.get({});
          await saveCookieJar(id, cookies);
        } catch (err) {
          logger.warn("session cookie capture failed", err);
        }

        const db = await getDb();
        await db.insert(gauntletSessions).values({
          id,
          label: payload.label,
          originPattern: payload.originPattern,
        });
        const meta: GauntletSessionMeta = {
          id,
          label: payload.label,
          originPattern: payload.originPattern,
          lastUsedAt: null,
          createdAt: Date.now(),
        };
        // slot.release() already called by 'closed' destruction path.
        return meta;
      },
    ),
  );

  // ── gauntlet:delete-session ──────────────────────────────────────────
  ipcMain.handle(
    "gauntlet:delete-session",
    guarded(
      "gauntlet:delete-session",
      async (_event: IpcMainInvokeEvent, payload: { id: string }) => {
        if (!payload?.id) throw new Error("gauntlet:delete-session requires id");
        const db = await getDb();
        await db
          .delete(gauntletSessions)
          .where(eq(gauntletSessions.id, payload.id));
        await deleteCookieJar(payload.id);
        return { ok: true };
      },
    ),
  );

  // ── gauntlet:test-firecrawl ──────────────────────────────────────────
  ipcMain.handle(
    "gauntlet:test-firecrawl",
    guarded("gauntlet:test-firecrawl", async () => pingFirecrawl()),
  );

  // ── gauntlet:test-ollama ─────────────────────────────────────────────
  ipcMain.handle(
    "gauntlet:test-ollama",
    guarded("gauntlet:test-ollama", async () => pingOllama()),
  );

  // ── gauntlet:verify-only (ad-hoc Whitehat scan) ─────────────────────
  ipcMain.handle(
    "gauntlet:verify-only",
    guarded(
      "gauntlet:verify-only",
      async (
        _event: IpcMainInvokeEvent,
        payload: { markdown: string; intent: string; model?: string },
      ) => {
        if (typeof payload?.markdown !== "string" || !payload?.intent) {
          throw new Error(
            "gauntlet:verify-only requires { markdown, intent }",
          );
        }
        return verifyMarkdown(payload.markdown, payload.intent, {
          model: payload.model,
        });
      },
    ),
  );

  // suppress unused logger warning if every branch is success
  void logger;
}
