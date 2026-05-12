/**
 * Copilot IPC handlers — NLP-driven self-healing assistant.
 *
 * Channels:
 *   copilot:ask           — submit a plain-English prompt; returns job row
 *   copilot:list-jobs     — list recent copilot jobs
 *   copilot:get-job       — fetch a single job
 *   copilot:approve-job   — approve an awaiting-approval job (Claude diff)
 *   copilot:reject-job    — reject an awaiting-approval job
 *   copilot:cancel-job    — cancel an in-flight job
 *
 * Streaming events sent back to renderer:
 *   copilot:progress      — { jobId, stage, content } incremental updates
 */

import { ipcMain } from "electron";
import log from "electron-log";
import { getCopilotService } from "@/lib/copilot/copilot_service";
import { guarded } from "@/ipc/utils/guarded_handle";

const logger = log.scope("copilot_handlers");

export function registerCopilotHandlers(): void {
  ipcMain.handle(
    "copilot:ask",
    guarded(
      "copilot:ask",
      async (
        event,
        payload: {
          prompt: string;
          routerModel?: string;
          claudeApiKey?: string;
        },
      ) => {
        if (!payload?.prompt || typeof payload.prompt !== "string") {
          throw new Error("copilot:ask requires a non-empty prompt");
        }
        const svc = getCopilotService();
        const sender = event.sender;
        const result = await svc.ask({
          prompt: payload.prompt,
          routerOptions: payload.routerModel
            ? { model: payload.routerModel }
            : undefined,
          claudeApiKey: payload.claudeApiKey,
          onProgress: (chunk) => {
            try {
              if (!sender.isDestroyed()) {
                sender.send("copilot:progress", {
                  stage: chunk.stage,
                  content: chunk.content,
                });
              }
            } catch {
              /* renderer gone */
            }
          },
        });
        return result.job;
      },
    ),
  );

  ipcMain.handle("copilot:list-jobs", async (_event, limit?: number) => {
    return getCopilotService().list(typeof limit === "number" ? limit : 50);
  });

  ipcMain.handle("copilot:get-job", async (_event, jobId: string) => {
    if (!jobId) throw new Error("copilot:get-job requires a jobId");
    return getCopilotService().get(jobId) ?? null;
  });

  ipcMain.handle(
    "copilot:approve-job",
    guarded(
      "copilot:approve-job",
      async (_event, payload: { jobId: string; approverDid?: string }) => {
        if (!payload?.jobId) throw new Error("copilot:approve-job requires jobId");
        return getCopilotService().approve(
          payload.jobId,
          payload.approverDid ?? "did:joy:local-user",
        );
      },
    ),
  );

  ipcMain.handle(
    "copilot:reject-job",
    guarded(
      "copilot:reject-job",
      async (
        _event,
        payload: { jobId: string; approverDid?: string; reason?: string },
      ) => {
        if (!payload?.jobId) throw new Error("copilot:reject-job requires jobId");
        return getCopilotService().reject(
          payload.jobId,
          payload.approverDid ?? "did:joy:local-user",
          payload.reason,
        );
      },
    ),
  );

  ipcMain.handle(
    "copilot:cancel-job",
    guarded("copilot:cancel-job", async (_event, payload: { jobId: string }) => {
      if (!payload?.jobId) throw new Error("copilot:cancel-job requires jobId");
      return getCopilotService().cancel(payload.jobId);
    }),
  );

  logger.info("Copilot handlers registered");
}
