/**
 * Browser pool for the Left Gauntlet — drives Electron's own built-in
 * Chromium via `BrowserWindow` + `webContents`. No external Chrome required.
 *
 * Each acquired slot is a fresh hidden BrowserWindow with an isolated
 * partition so cookies don't bleed between runs (unless a `sessionId` is
 * provided, in which case the partition is derived from that id and
 * persisted to disk).
 */

import { BrowserWindow, session as electronSession } from "electron";
import path from "node:path";
import fs from "node:fs/promises";
import { getUserDataPath } from "@/paths/paths";
import { GauntletError } from "./types";

export interface BrowserSlot {
  window: BrowserWindow;
  partition: string;
  /** Release the slot back to the pool. */
  release(): Promise<void>;
}

interface PoolOptions {
  /** Max concurrent windows. Default 2. */
  capacity?: number;
  /** Visible on screen (true = headful) or hidden offscreen (false). */
  visible?: boolean;
  /** Show DevTools when launching. */
  devtools?: boolean;
}

const DEFAULT_CAPACITY = 2;

class GauntletBrowserPool {
  private inUse = 0;
  private waiters: Array<() => void> = [];
  private capacity = DEFAULT_CAPACITY;

  setCapacity(n: number): void {
    if (Number.isFinite(n) && n >= 1 && n <= 8) {
      this.capacity = Math.floor(n);
    }
  }

  async acquire(
    sessionId: string | undefined,
    opts: PoolOptions = {},
  ): Promise<BrowserSlot> {
    if (this.inUse >= this.capacity) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.inUse += 1;
    let window: BrowserWindow | null = null;
    try {
      const partition = sessionId
        ? `persist:gauntlet-${sessionId}`
        : `gauntlet-tx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      // Pre-warm partition directory so persisted sessions are crash-safe.
      if (sessionId) {
        await fs.mkdir(
          path.join(getUserDataPath(), "Partitions", `gauntlet-${sessionId}`),
          { recursive: true },
        );
      }

      const ses = electronSession.fromPartition(partition, {
        cache: true,
      });

      // A realistic-ish UA to dodge naive bot-blockers.
      ses.setUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
      );

      window = new BrowserWindow({
        show: opts.visible === true,
        width: 1280,
        height: 800,
        webPreferences: {
          partition,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          devTools: opts.devtools === true,
        },
      });

      const slot: BrowserSlot = {
        window,
        partition,
        release: async () => {
          try {
            if (window && !window.isDestroyed()) {
              window.destroy();
            }
          } catch {
            // ignore
          } finally {
            this.inUse -= 1;
            const next = this.waiters.shift();
            if (next) next();
          }
        },
      };
      return slot;
    } catch (err) {
      this.inUse -= 1;
      const next = this.waiters.shift();
      if (next) next();
      try {
        if (window && !window.isDestroyed()) window.destroy();
      } catch {
        // ignore
      }
      throw new GauntletError(
        "BROWSER_LAUNCH_FAILED",
        `Failed to launch Electron BrowserWindow: ${(err as Error).message}`,
        err,
      );
    }
  }

  /** Test/diagnostic — current usage. */
  stats(): { inUse: number; waiters: number; capacity: number } {
    return {
      inUse: this.inUse,
      waiters: this.waiters.length,
      capacity: this.capacity,
    };
  }
}

export const browserPool = new GauntletBrowserPool();
