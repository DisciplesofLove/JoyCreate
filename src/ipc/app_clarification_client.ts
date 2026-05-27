/**
 * App Clarification Agent — renderer-side IPC client.
 *
 * Channel surface (mirrors `src/ipc/handlers/app_clarification_agent_handlers.ts`):
 *   - invoke `app-clarification:run`     → ClarificationRunResult
 *   - invoke `app-clarification:answer`  → void
 *   - invoke `app-clarification:cancel`  → void
 *   - on     `app-clarification:event`   → ClarificationEvent
 *
 * Types are duplicated here intentionally so the renderer never imports
 * from a main-process handler module (which pulls in `electron`).
 */

import { IpcClient } from "@/ipc/ipc_client";
import type { DataLayerConfig } from "@/shared/data_layer_types";

export type QuickStartProjectType =
  | "app"
  | "website"
  | "game"
  | "ui-skin"
  | "agent-ui"
  | "mobile"
  | "desktop";

export interface QuickStartConfig {
  projectType?: QuickStartProjectType;
  framework?: string;
  uiLibrary?: string;
  category?: string;
  templateId?: string;
  buildMode?: string;
  styleHints?: { color?: string; font?: string; mood?: string };
  deploymentTargets?: string[];
  features?: string[];
  knowledgeNotes?: string;
  /**
   * Data + Backend Layer selection. When omitted, defaults are derived
   * via `defaultDataLayerFor(projectType)` at brief-build time.
   */
  dataLayer?: DataLayerConfig;
}

export interface BuildBrief {
  title: string;
  summary: string;
  projectType: QuickStartProjectType;
  framework: string;
  uiLibrary: string;
  category: string;
  templateId?: string;
  buildMode: string;
  styleHints: { color?: string; font?: string; mood?: string };
  deploymentTargets: string[];
  features: string[];
  knowledgeNotes: string;
  refinedPrompt: string;
}

export interface ClarificationRunResult {
  runId: string;
  brief: BuildBrief;
  finished: boolean;
}

export type ClarificationEventKind =
  | "started"
  | "thinking"
  | "question"
  | "answer-received"
  | "brief"
  | "error"
  | "done";

export interface ClarificationEvent {
  runId: string;
  kind: ClarificationEventKind;
  message?: string;
  question?: {
    text: string;
    suggestions?: string[];
    allowFreeform?: boolean;
  };
  brief?: BuildBrief;
  error?: string;
}

function ipc() {
  return IpcClient.getInstance();
}

class AppClarificationClient {
  private static instance: AppClarificationClient | null = null;
  static getInstance(): AppClarificationClient {
    if (!this.instance) this.instance = new AppClarificationClient();
    return this.instance;
  }

  async run(opts: {
    prompt: string;
    config?: QuickStartConfig;
    model?: string;
    provider?: string;
  }): Promise<ClarificationRunResult> {
    return ipc().invoke(
      "app-clarification:run",
      opts,
    ) as Promise<ClarificationRunResult>;
  }

  async answer(runId: string, answer: string): Promise<void> {
    await ipc().invoke("app-clarification:answer", { runId, answer });
  }

  async cancel(runId: string): Promise<void> {
    await ipc().invoke("app-clarification:cancel", runId);
  }

  /** Subscribe to streaming events. Returns an unsubscribe function. */
  onEvent(callback: (event: ClarificationEvent) => void): () => void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const electron = (window as any).electron;
    if (!electron?.ipcRenderer) {
      throw new Error(
        "App clarification IPC not available — preload not loaded",
      );
    }
    const handler = (_evt: unknown, payload: ClarificationEvent) =>
      callback(payload);
    electron.ipcRenderer.on("app-clarification:event", handler);
    return () => {
      electron.ipcRenderer.removeListener?.(
        "app-clarification:event",
        handler,
      );
    };
  }
}

export const appClarificationClient = AppClarificationClient.getInstance();
