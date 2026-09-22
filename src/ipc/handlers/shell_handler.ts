import { app, shell } from "electron";
import path from "node:path";
import os from "node:os";
import log from "electron-log";
import { createLoggedHandler } from "./safe_handle";
import { guarded } from "@/ipc/utils/guarded_handle";
import { isSafeExternalUrl, sanitizeRevealPath } from "@/main_security";

const logger = log.scope("shell_handlers");
const handle = createLoggedHandler(logger);

/**
 * Allowed roots for `shell.showItemInFolder`.
 *
 * The renderer must not be able to pop the OS file manager at arbitrary
 * system paths — that's a reconnaissance primitive on any compromised
 * renderer (it leaks directory listings, file names, install paths). We
 * restrict it to paths under JoyCreate-managed roots: the user's home dir
 * for `.openclaw` workspace, the app's userData, app's data, and the
 * standard downloads folder (because exported assets land there).
 */
function getAllowedRevealRoots(): readonly string[] {
  const roots: string[] = [];
  try { roots.push(app.getPath("userData")); } catch { /* not ready yet */ }
  try { roots.push(app.getPath("downloads")); } catch { /* unsupported */ }
  try { roots.push(app.getPath("documents")); } catch { /* unsupported */ }
  try { roots.push(app.getPath("pictures")); } catch { /* unsupported */ }
  try { roots.push(app.getPath("videos")); } catch { /* unsupported */ }
  try { roots.push(app.getPath("music")); } catch { /* unsupported */ }
  try { roots.push(app.getPath("desktop")); } catch { /* unsupported */ }
  try { roots.push(app.getPath("temp")); } catch { /* unsupported */ }
  try { roots.push(path.join(os.homedir(), ".openclaw")); } catch { /* unsupported */ }
  try { roots.push(path.join(os.homedir(), "joycreate")); } catch { /* unsupported */ }
  return roots;
}

export function registerShellHandlers() {
  handle(
    "open-external-url",
    guarded("open-external-url", async (_event, url: string) => {
      if (!url) {
        throw new Error("No URL provided.");
      }
      // `isSafeExternalUrl` rejects anything that isn't http(s) — including
      // file:, javascript:, data:, vbscript:, and malformed URLs. This is
      // stricter than the previous `startsWith("http://")` check, which
      // would have accepted "http://" embedded inside a `javascript:`
      // payload sneaking through certain URL parsers.
      if (!isSafeExternalUrl(url)) {
        throw new Error("Attempted to open invalid or non-http URL: " + url);
      }
      await shell.openExternal(url);
      logger.debug("Opened external URL:", url);
    }),
  );

  handle(
    "show-item-in-folder",
    guarded("show-item-in-folder", async (_event, fullPath: string) => {
      if (!fullPath) {
        throw new Error("No file path provided.");
      }
      const safe = sanitizeRevealPath(fullPath, getAllowedRevealRoots());
      if (!safe) {
        logger.warn(
          "Blocked show-item-in-folder for path outside allowed roots:",
          fullPath,
        );
        throw new Error(
          "Refusing to reveal item outside JoyCreate-managed directories.",
        );
      }
      shell.showItemInFolder(safe);
      logger.debug("Showed item in folder:", safe);
    }),
  );
}
