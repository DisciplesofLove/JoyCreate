/**
 * Sovereign Blueprint IPC handlers — main-process surface for the
 * BlueprintOrchestrator. Mutating channels go through Neural Guard via
 * `guarded()`; read channels are unwrapped invoke handlers.
 */

import { ipcMain, type IpcMainInvokeEvent } from "electron";
import log from "electron-log";
import { guarded } from "@/ipc/utils/guarded_handle";
import {
  getBlueprintOrchestrator,
  type RunBlueprintOptions,
} from "@/lib/blueprint/orchestrator";
import { getRun, listRuns } from "@/lib/blueprint/run_store";
import {
  composeBlueprint,
  validateBlueprintYaml,
  rehashBlueprintYaml,
  listBuiltinAdapters,
} from "@/lib/blueprint/composer";

const logger = log.scope("blueprint_handlers");

interface RunPayload {
  yamlText: string;
  input?: Record<string, unknown>;
  agentDid?: string;
  dryRun?: boolean;
}

interface ComposePayload {
  intent: string;
  authorDid?: string;
  modelId?: string;
  hints?: string;
  /** When true, immediately run the composed blueprint and return { runId }. */
  autoRun?: boolean;
  input?: Record<string, unknown>;
}

export function registerBlueprintHandlers(): void {
  ipcMain.handle(
    "blueprint:run",
    guarded("blueprint:run", async (_event: IpcMainInvokeEvent, payload: RunPayload) => {
      if (!payload?.yamlText || typeof payload.yamlText !== "string") {
        throw new Error("blueprint:run requires { yamlText: string }");
      }
      const opts: RunBlueprintOptions = {
        yamlText: payload.yamlText,
        input: payload.input,
        agentDid: payload.agentDid,
        dryRun: payload.dryRun,
      };
      const runId = await getBlueprintOrchestrator().run(opts);
      return { runId };
    }),
  );

  ipcMain.handle(
    "blueprint:cancel",
    guarded(
      "blueprint:cancel",
      async (_event: IpcMainInvokeEvent, payload: { runId: string }) => {
        if (!payload?.runId) throw new Error("blueprint:cancel requires { runId }");
        await getBlueprintOrchestrator().cancel(payload.runId);
        return { ok: true };
      },
    ),
  );

  ipcMain.handle(
    "blueprint:get-run",
    async (_event: IpcMainInvokeEvent, runId: string) => {
      if (!runId) throw new Error("blueprint:get-run requires runId");
      const run = await getRun(runId);
      if (!run) throw new Error(`Run ${runId} not found`);
      return run;
    },
  );

  ipcMain.handle(
    "blueprint:list-runs",
    async (_event: IpcMainInvokeEvent, limit?: number) => {
      return listRuns(limit ?? 100);
    },
  );

  // ── Composer / validator / catalog ──────────────────────────────────────
  ipcMain.handle(
    "blueprint:compose",
    guarded(
      "blueprint:compose",
      async (_event: IpcMainInvokeEvent, payload: ComposePayload) => {
        if (!payload?.intent || typeof payload.intent !== "string") {
          throw new Error("blueprint:compose requires { intent: string }");
        }
        const composed = await composeBlueprint({
          intent: payload.intent,
          authorDid: payload.authorDid,
          modelId: payload.modelId,
          hints: payload.hints,
        });
        if (payload.autoRun) {
          const runId = await getBlueprintOrchestrator().run({
            yamlText: composed.yaml,
            input: payload.input,
            agentDid: payload.authorDid,
          });
          return { yaml: composed.yaml, blueprint: composed.blueprint, runId };
        }
        return { yaml: composed.yaml, blueprint: composed.blueprint };
      },
    ),
  );

  ipcMain.handle(
    "blueprint:validate",
    async (_event: IpcMainInvokeEvent, payload: { yamlText: string }) => {
      if (!payload?.yamlText) throw new Error("blueprint:validate requires { yamlText }");
      return { blueprint: validateBlueprintYaml(payload.yamlText) };
    },
  );

  ipcMain.handle(
    "blueprint:rehash",
    guarded(
      "blueprint:rehash",
      async (_event: IpcMainInvokeEvent, payload: { yamlText: string }) => {
        if (!payload?.yamlText) throw new Error("blueprint:rehash requires { yamlText }");
        const yaml = await rehashBlueprintYaml(payload.yamlText);
        return { yaml };
      },
    ),
  );

  ipcMain.handle("blueprint:list-adapters", async () => {
    return listBuiltinAdapters();
  });

  // Resume any runs that were left in pending/running/paused state by a
  // previous session. Errors here are non-fatal — the app must still boot.
  void getBlueprintOrchestrator()
    .resumeAllPending()
    .catch((err) => logger.error("resumeAllPending failed:", err));
}
