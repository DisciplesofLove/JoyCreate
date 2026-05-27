/**
 * Browser Agent IPC Client — renderer-side wrapper.
 */

import type {
  BrowserAgentAction,
  BrowserAgentPlanRequest,
} from "../../types/browser_agent";

export class BrowserAgentClient {
  private static instance: BrowserAgentClient;

  static getInstance(): BrowserAgentClient {
    if (!BrowserAgentClient.instance) {
      BrowserAgentClient.instance = new BrowserAgentClient();
    }
    return BrowserAgentClient.instance;
  }

  private invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
    return window.electron.ipcRenderer.invoke(channel, ...args) as Promise<T>;
  }

  planStep(req: BrowserAgentPlanRequest): Promise<BrowserAgentAction> {
    return this.invoke<BrowserAgentAction>("browser-agent:plan-step", req);
  }
}

export const browserAgentClient = BrowserAgentClient.getInstance();
