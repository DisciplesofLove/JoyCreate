/**
 * Tray presence and background lifecycle.
 *
 * Every scheduler, watchdog, event subscriber and in-flight agent run in this
 * app lives in the main process. Until now `window-all-closed` called
 * `app.quit()` on Windows and Linux, so closing the last window ended all of
 * them — an agent OS whose agents stop when you close the window.
 *
 * With background mode on (the default), closing the window hides the app and
 * the main process keeps working. Quitting becomes explicit: the tray menu, or
 * Cmd/Ctrl-Q. `isQuitting` is the flag that distinguishes "user closed a
 * window" from "user is quitting", and it must be set before `app.quit()` or
 * the close handler will simply hide the window again.
 *
 * Note `src/pages/SovereignForgePage.tsx` already tells users to use "the tray
 * menu" to start and stop services — this makes that copy true.
 */

import path from "node:path";
import { app, BrowserWindow, Menu, Tray, nativeImage } from "electron";
import log from "electron-log";

const logger = log.scope("background-tray");

let tray: Tray | null = null;
let isQuitting = false;

/** Reported in the tray tooltip so the user can see the app is doing something. */
let activityCounter: () => number = () => 0;

/**
 * Any path into `app.quit()` counts as quitting — the tray item, Cmd/Ctrl-Q,
 * the auto-updater, a Squirrel restart.
 *
 * Without this, background mode would break quitting entirely: `app.quit()`
 * fires `before-quit`, then each window's `close`, and the close handler would
 * preventDefault and silently cancel the quit. Setting the flag here means the
 * close handler lets it through.
 */
app.on("before-quit", () => {
  isQuitting = true;
});

/**
 * True once the user has actually asked to quit. Window close handlers check
 * this to decide between hiding and letting the close proceed.
 */
export function isAppQuitting(): boolean {
  return isQuitting;
}

/** Mark the app as quitting, then quit. The only sanctioned way out. */
export function quitApp(): void {
  isQuitting = true;
  app.quit();
}

/**
 * Supply a function returning the number of currently running agent activities.
 * Wired once the run store exists; until then the tray just shows the app name.
 */
export function setActivityCounter(fn: () => number): void {
  activityCounter = fn;
}

function resolveTrayIcon(): Electron.NativeImage {
  // Reuse the app icon — `assets/icon/logo.png`, the same source
  // `forge.config.ts` points at. Packaged and dev layouts differ, so try both.
  const candidates = [
    path.join(process.resourcesPath ?? "", "assets", "icon", "logo.png"),
    path.join(app.getAppPath(), "assets", "icon", "logo.png"),
    path.join(__dirname, "..", "assets", "icon", "logo.png"),
    path.join(__dirname, "..", "..", "assets", "icon", "logo.png"),
  ];
  for (const candidate of candidates) {
    const image = nativeImage.createFromPath(candidate);
    if (!image.isEmpty()) {
      return image.resize({ width: 16, height: 16 });
    }
  }
  // An empty image still produces a clickable tray entry, which is better than
  // throwing and losing background mode entirely.
  logger.warn("no tray icon found; using an empty image");
  return nativeImage.createEmpty();
}

function showMainWindow(getWindow: () => BrowserWindow | null): void {
  const win = getWindow();
  if (!win) {
    // Every window was closed; the caller re-creates one.
    app.emit("activate");
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function buildMenu(getWindow: () => BrowserWindow | null): Electron.Menu {
  const running = activityCounter();
  return Menu.buildFromTemplate([
    {
      label: running > 0 ? `${running} agent run(s) in progress` : "No agent runs in progress",
      enabled: false,
    },
    { type: "separator" },
    { label: "Open JoyCreate", click: () => showMainWindow(getWindow) },
    { type: "separator" },
    { label: "Quit JoyCreate", click: () => quitApp() },
  ]);
}

/**
 * Create the tray. Safe to call more than once; subsequent calls are no-ops.
 *
 * `getWindow` is a getter rather than a window because the window is destroyed
 * and re-created across hide/show cycles.
 */
export function initBackgroundTray(getWindow: () => BrowserWindow | null): void {
  if (tray) return;
  try {
    tray = new Tray(resolveTrayIcon());
    tray.setToolTip("JoyCreate");
    tray.on("click", () => showMainWindow(getWindow));
    // Rebuild on open so the run count is current rather than whatever it was
    // when the tray was created.
    tray.on("right-click", () => tray?.popUpContextMenu(buildMenu(getWindow)));
    tray.setContextMenu(buildMenu(getWindow));
    logger.info("tray created — background mode active");
  } catch (err) {
    // A missing tray must not stop the app from starting.
    logger.warn("failed to create tray:", err);
    tray = null;
  }
}

export function destroyBackgroundTray(): void {
  tray?.destroy();
  tray = null;
}

/** Reflect the user's launch-at-login preference. No-op where unsupported. */
export function applyOpenAtLogin(enabled: boolean): void {
  try {
    app.setLoginItemSettings({ openAtLogin: enabled });
  } catch (err) {
    logger.warn("could not set login item:", err);
  }
}
