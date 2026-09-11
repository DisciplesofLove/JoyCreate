/**
 * Finding the agent CLIs on this machine.
 *
 * `PATH` alone is not enough. A GUI-launched Electron app on Windows does not
 * inherit the shell's `PATH` at all, and on macOS it inherits `launchd`'s rather
 * than the login shell's — which is exactly why a CLI the user can run in their
 * terminal is invisible to the app. So we check `PATH` and then the handful of
 * directories these tools actually install into.
 *
 * Nothing here opens a credential file. "Signed in" is inferred from the
 * existence of a path the CLI creates at login; the only thing that *proves* a
 * subscription works is running a prompt through it, which is what the Test
 * button does.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import log from "electron-log";

import {
  SUBSCRIPTION_CLIS,
  getSubscriptionCli,
  type SubscriptionCliDefinition,
} from "./cli_registry";

const logger = log.scope("subscription-cli");

export interface CliDetection {
  id: string;
  label: string;
  vendor: string;
  subscription: string;
  /** Absolute path to the executable, or null when it is not installed. */
  binaryPath: string | null;
  version: string | null;
  installed: boolean;
  /**
   * Whether the login-created credential path exists. A hint for the UI, not a
   * guarantee — the token behind it may be expired.
   */
  signedIn: boolean;
  loginCommand: string;
  installCommand: string;
  docsUrl: string;
  models: { id: string; label: string; description: string }[];
  /** One line the UI can show verbatim. */
  status: string;
}

/** Cache detections briefly — the settings UI polls, and stat-ing is not free. */
const CACHE_TTL_MS = 15_000;
let cache: { at: number; value: CliDetection[] } | null = null;

function candidateDirectories(def: SubscriptionCliDefinition): string[] {
  const dirs: string[] = [];
  const pathVar = process.env.PATH ?? process.env.Path ?? "";
  for (const entry of pathVar.split(path.delimiter)) {
    if (entry.trim()) dirs.push(entry.trim());
  }
  for (const { env, suffix } of def.searchPaths) {
    // HOME is absent on Windows and USERPROFILE on POSIX; os.homedir() covers
    // both, so the same table works on every platform.
    const base = process.env[env] ?? (env === "HOME" || env === "USERPROFILE" ? os.homedir() : undefined);
    if (base) dirs.push(path.join(base, suffix));
  }
  return dirs;
}

function findBinary(def: SubscriptionCliDefinition): string | null {
  for (const dir of candidateDirectories(def)) {
    for (const name of def.binaries) {
      const candidate = path.join(dir, name);
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          return candidate;
        }
      } catch {
        // An unreadable directory on PATH is common and uninteresting.
      }
    }
  }
  return null;
}

/**
 * Run the CLI's own `--version`. Bounded, because a binary that turns out to be
 * interactive would otherwise hang the settings page forever.
 */
function readVersion(binaryPath: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value: string | null) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };

    let child;
    try {
      child = spawn(binaryPath, args, {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        // .cmd shims (how npm installs these on Windows) are not executables.
        shell: process.platform === "win32" && binaryPath.endsWith(".cmd"),
      });
    } catch (err) {
      logger.debug(`version probe could not spawn ${binaryPath}:`, err);
      return done(null);
    }

    let out = "";
    child.stdout?.on("data", (d) => (out += String(d)));
    child.stderr?.on("data", (d) => (out += String(d)));

    const timer = setTimeout(() => {
      child.kill();
      done(null);
    }, 8_000);

    child.on("error", () => {
      clearTimeout(timer);
      done(null);
    });
    child.on("close", () => {
      clearTimeout(timer);
      const line = out.trim().split(/\r?\n/)[0]?.trim() ?? "";
      done(line || null);
    });
  });
}

/**
 * Has the user logged in to this CLI?
 *
 * Existence and size only — the contents are the CLI's business. The size floor
 * is not paranoia: on this machine `~/.claude/.credentials.json` exists and
 * contains exactly `{}`, two bytes, because the file is created before login
 * completes. Treating that as "signed in" would have shown a green Ready badge
 * to someone who had never logged in.
 */
function credentialExists(def: SubscriptionCliDefinition): boolean {
  const MIN_CREDENTIAL_BYTES = 16;
  for (const hint of def.credentialHints) {
    try {
      const stat = fs.statSync(path.join(os.homedir(), hint));
      if (stat.isFile() && stat.size >= MIN_CREDENTIAL_BYTES) return true;
    } catch {
      // Missing is the normal case for the platforms this hint is not for.
    }
  }
  return false;
}

function describe(d: Omit<CliDetection, "status">): string {
  if (!d.installed) return `Not installed — run: ${d.installCommand}`;
  if (!d.signedIn) return `Installed, but not signed in — run: ${d.loginCommand}`;
  return `Ready${d.version ? ` — ${d.version}` : ""}`;
}

/** Detect every known CLI. */
export async function detectSubscriptionClis(
  opts: { force?: boolean } = {},
): Promise<CliDetection[]> {
  if (!opts.force && cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.value;
  }

  const results = await Promise.all(
    SUBSCRIPTION_CLIS.map(async (def) => {
      const binaryPath = findBinary(def);
      const version = binaryPath
        ? await readVersion(binaryPath, def.versionArgs)
        : null;
      const partial = {
        id: def.id,
        label: def.label,
        vendor: def.vendor,
        subscription: def.subscription,
        binaryPath,
        version,
        installed: binaryPath !== null,
        signedIn: binaryPath !== null && credentialExists(def),
        loginCommand: def.loginCommand,
        installCommand: def.installCommand,
        docsUrl: def.docsUrl,
        models: def.models,
      };
      return { ...partial, status: describe(partial) };
    }),
  );

  cache = { at: Date.now(), value: results };
  return results;
}

export async function detectSubscriptionCli(
  id: string,
): Promise<CliDetection | null> {
  const all = await detectSubscriptionClis();
  return all.find((c) => c.id === id) ?? null;
}

/**
 * Resolve the executable for a run, throwing the reason if we cannot.
 *
 * Throwing rather than returning null is deliberate and matches the repo
 * convention: a chat that silently answers nothing is worse than one that says
 * "Claude Code is not installed".
 */
export async function requireCliBinary(id: string): Promise<{
  def: SubscriptionCliDefinition;
  binaryPath: string;
}> {
  const def = getSubscriptionCli(id);
  if (!def) throw new Error(`Unknown subscription CLI: ${id}`);

  const detection = await detectSubscriptionCli(id);
  if (!detection?.binaryPath) {
    throw new Error(
      `${def.label} needs the ${def.vendor} CLI, which is not installed. ` +
        `Install it with:  ${def.installCommand}   then sign in with:  ${def.loginCommand}`,
    );
  }
  return { def, binaryPath: detection.binaryPath };
}

/** Drop the cache — called after a detected install/login so the UI updates. */
export function invalidateCliDetectionCache(): void {
  cache = null;
}
