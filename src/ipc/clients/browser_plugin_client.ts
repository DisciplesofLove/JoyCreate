/**
 * Browser Plugin IPC Client — renderer-side API.
 */

import type {
  BrowserPlugin,
  BuildBrowserPluginRequest,
  CreateBrowserPluginRequest,
  UpdateBrowserPluginRequest,
} from "../../types/browser_plugin";

export class BrowserPluginClient {
  private static instance: BrowserPluginClient;

  static getInstance(): BrowserPluginClient {
    if (!BrowserPluginClient.instance) {
      BrowserPluginClient.instance = new BrowserPluginClient();
    }
    return BrowserPluginClient.instance;
  }

  private invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
    return window.electron.ipcRenderer.invoke(channel, ...args) as Promise<T>;
  }

  list(): Promise<BrowserPlugin[]> {
    return this.invoke<BrowserPlugin[]>("browser-plugins:list");
  }

  save(
    params: CreateBrowserPluginRequest | UpdateBrowserPluginRequest,
  ): Promise<BrowserPlugin> {
    return this.invoke<BrowserPlugin>("browser-plugins:save", params);
  }

  remove(id: string): Promise<{ ok: true }> {
    return this.invoke<{ ok: true }>("browser-plugins:delete", { id });
  }

  toggle(id: string, enabled: boolean): Promise<BrowserPlugin> {
    return this.invoke<BrowserPlugin>("browser-plugins:toggle", {
      id,
      enabled,
    });
  }

  build(params: BuildBrowserPluginRequest): Promise<BrowserPlugin> {
    return this.invoke<BrowserPlugin>("browser-plugins:build", params);
  }
}

export const browserPluginClient = BrowserPluginClient.getInstance();
