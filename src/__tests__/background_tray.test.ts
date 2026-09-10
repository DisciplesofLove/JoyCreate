/**
 * Background mode is a trap if the app can no longer be quit.
 *
 * The window `close` handler in `src/main.ts` calls `preventDefault()` and
 * hides the window instead of closing it. `app.quit()` fires `before-quit` and
 * THEN closes each window, so without a flag flipped in `before-quit` the
 * handler would cancel every quit — including Cmd/Ctrl-Q, the auto-updater and
 * Squirrel restarts, leaving a process the user cannot get rid of except
 * through Task Manager.
 *
 * These tests pin that contract.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

const { appMock, handlers } = vi.hoisted(() => {
  const handlers = new Map<string, () => void>();
  return {
    handlers,
    appMock: {
      on: (event: string, fn: () => void) => {
        handlers.set(event, fn);
      },
      quit: vi.fn(),
      getAppPath: () => process.cwd(),
      setLoginItemSettings: vi.fn(),
    },
  };
});

vi.mock("electron", () => ({
  app: appMock,
  BrowserWindow: class {},
  Menu: { buildFromTemplate: () => ({}) },
  Tray: class {
    setToolTip() {}
    setContextMenu() {}
    on() {}
    destroy() {}
  },
  nativeImage: {
    createFromPath: () => ({ isEmpty: () => true, resize: () => ({}) }),
    createEmpty: () => ({}),
  },
}));

vi.mock("electron-log", () => ({
  default: {
    scope: () => ({ info: () => undefined, warn: () => undefined, error: () => undefined }),
  },
}));

import {
  applyOpenAtLogin,
  isAppQuitting,
  quitApp,
} from "@/main/background_tray";

describe("background mode quit contract", () => {
  beforeEach(() => {
    appMock.quit.mockClear();
    appMock.setLoginItemSettings.mockClear();
  });

  it("registers a before-quit listener at import time", () => {
    // Registration must happen on import, not on tray creation — the app can be
    // quit before (or without) a tray ever existing.
    expect(handlers.has("before-quit")).toBe(true);
  });

  it("does not report quitting during normal operation", () => {
    // Fresh module state: a plain window close must be treated as "hide".
    expect(isAppQuitting()).toBe(false);
  });

  it("reports quitting once before-quit has fired", () => {
    handlers.get("before-quit")!();
    // This is the flag the window close handler reads to let the close through
    // instead of hiding. Without it the quit is silently cancelled.
    expect(isAppQuitting()).toBe(true);
  });

  it("quitApp flags the intent before calling app.quit", () => {
    quitApp();
    expect(isAppQuitting()).toBe(true);
    expect(appMock.quit).toHaveBeenCalledTimes(1);
  });

  it("forwards the launch-at-login preference both ways", () => {
    applyOpenAtLogin(true);
    expect(appMock.setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: true });
    applyOpenAtLogin(false);
    expect(appMock.setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: false });
  });

  it("survives a platform that rejects login-item settings", () => {
    appMock.setLoginItemSettings.mockImplementationOnce(() => {
      throw new Error("unsupported");
    });
    // Must not throw — a Linux desktop without autostart support should still boot.
    expect(() => applyOpenAtLogin(true)).not.toThrow();
  });
});
