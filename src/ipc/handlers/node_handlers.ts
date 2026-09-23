import { ipcMain, dialog } from "electron";
import { execSync } from "child_process";
import { platform, arch } from "os";
import { NodeSystemInfo } from "../ipc_types";
import fixPath from "fix-path";
import { runShellCommand } from "../utils/runShellCommand";
import log from "electron-log";
import { existsSync } from "fs";
import { join } from "path";
import { readSettings } from "../../main/settings";

const logger = log.scope("node_handlers");

/** Enrich PATH with known Node.js install locations on Windows and custom node path from settings */
function enrichPath(): void {
  if (platform() === "win32") {
    try {
      // Read PATH straight from the registry (Machine+User) instead of
      // `cmd /c echo %PATH%`, which only echoes this process's own inherited
      // env and misses PATH changes made after the app started (e.g. `nvm use`).
      const regPath = execSync(
        "powershell -NoProfile -NonInteractive -Command " +
          '"[System.Environment]::GetEnvironmentVariable(\'Path\',\'Machine\') + \';\' + [System.Environment]::GetEnvironmentVariable(\'Path\',\'User\')"',
        { encoding: "utf8" },
      ).trim();
      if (regPath) {
        process.env.PATH = regPath;
      }
    } catch { /* ignore */ }
    const { homedir } = require("os") as typeof import("os");
    const sep = ";";
    const candidates: string[] = [
      "C:\\Program Files\\nodejs",
      "C:\\Program Files (x86)\\nodejs",
      join(homedir(), "AppData", "Roaming", "npm"),
      join(homedir(), "AppData", "Local", "pnpm"),
      join(homedir(), "AppData", "Local", "Programs", "nodejs"),
      join(homedir(), "scoop", "apps", "nodejs", "current"),
      join(homedir(), "scoop", "shims"),
    ];
    // Note: deliberately not scanning nvm's per-version install dirs here —
    // adding every installed version to PATH (in filesystem/alphabetical
    // order) can shadow the actually-active version with an older one. The
    // nvm-managed symlink dir (already on PATH via the registry read above)
    // is the source of truth for which version is active.
    const settings = readSettings();
    const extras: string[] = [];
    if (settings?.customNodePath) extras.push(settings.customNodePath);
    for (const c of candidates) { if (existsSync(c)) extras.push(c); }
    const existing = (process.env.PATH || "").split(sep).filter(Boolean);
    const merged = [...extras, ...existing].filter((v, i, a) => a.indexOf(v) === i);
    process.env.PATH = merged.join(sep);
  } else {
    try { fixPath(); } catch { /* ignore */ }
    const settings = readSettings();
    if (settings?.customNodePath) {
      process.env.PATH = `${settings.customNodePath}:${process.env.PATH}`;
    }
  }
}

export function registerNodeHandlers() {
  ipcMain.handle("nodejs-status", async (): Promise<NodeSystemInfo> => {
    logger.log(
      "handling ipc: nodejs-status for platform:",
      platform(),
      "and arch:",
      arch(),
    );
    // Always enrich PATH before checking so packaged builds find node
    enrichPath();
    // Run checks in parallel
    const [nodeVersion, pnpmVersion] = await Promise.all([
      runShellCommand("node --version"),
      // First, check if pnpm is installed.
      // If not, try to install it using corepack.
      // If both fail, then pnpm is not available.
      runShellCommand(
        "pnpm --version || (corepack enable pnpm && pnpm --version) || (npm install -g pnpm@latest-10 && pnpm --version)",
      ),
    ]);
    // Default to mac download url.
    let nodeDownloadUrl = "https://nodejs.org/dist/v22.14.0/node-v22.14.0.pkg";
    if (platform() == "win32") {
      if (arch() === "arm64" || arch() === "arm") {
        nodeDownloadUrl =
          "https://nodejs.org/dist/v22.14.0/node-v22.14.0-arm64.msi";
      } else {
        // x64 is the most common architecture for Windows so it's the
        // default download url.
        nodeDownloadUrl =
          "https://nodejs.org/dist/v22.14.0/node-v22.14.0-x64.msi";
      }
    }
    return { nodeVersion, pnpmVersion, nodeDownloadUrl };
  });

  ipcMain.handle("reload-env-path", async (): Promise<void> => {
    logger.debug("Reloading env path, previously:", process.env.PATH);
    enrichPath();
    logger.debug("Reloaded env path, now:", process.env.PATH);
  });
  ipcMain.handle("select-node-folder", async () => {
    const result = await dialog.showOpenDialog({
      title: "Select Node.js Installation Folder",
      properties: ["openDirectory"],
      message: "Select the folder where Node.js is installed",
    });

    if (result.canceled) {
      return { path: null, canceled: true, selectedPath: null };
    }

    if (!result.filePaths[0]) {
      return { path: null, canceled: false, selectedPath: null };
    }

    const selectedPath = result.filePaths[0];

    // Verify Node.js exists in selected path
    const nodeBinary = platform() === "win32" ? "node.exe" : "node";
    const nodePath = join(selectedPath, nodeBinary);

    if (!existsSync(nodePath)) {
      // Check bin subdirectory (common on Unix systems)
      const binPath = join(selectedPath, "bin", nodeBinary);
      if (existsSync(binPath)) {
        return {
          path: join(selectedPath, "bin"),
          canceled: false,
          selectedPath,
        };
      }
      return { path: null, canceled: false, selectedPath };
    }
    return { path: selectedPath, canceled: false, selectedPath };
  });
}
