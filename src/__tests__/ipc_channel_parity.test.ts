import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

// ── IPC channel ↔ handler parity ─────────────────────────────────────────────
// Every channel exposed to the renderer via the preload allowlist
// (validInvokeChannels in src/preload.ts) must have a corresponding
// ipcMain.handle registration somewhere in main-process code. A channel in the
// allowlist without a handler crashes at runtime with
// "No handler registered for '<channel>'" — this test catches that at CI time.

const ROOT = path.resolve(__dirname, "..", "..");

/** Directories that contain main-process handler registrations. */
const MAIN_PROCESS_DIRS = [
  "src/ipc/handlers",
  "src/ipc/utils",
  "src/pro",
  "src/lib",
  "src/main",
];
const MAIN_PROCESS_FILES = ["src/ipc/ipc_host.ts"];

/** Registration call patterns: ipcMain.handle("x"), handle("x"), testOnlyHandle("x") */
const REGISTRATION_PATTERN =
  /(?:ipcMain\.handle|(?<![.\w])handle|(?<![.\w])testOnlyHandle)\(\s*["'`]([^"'`]+)["'`]/g;

/**
 * Some handler files register channels via constant maps, e.g.
 * `const CHANNELS = { X: "jcn:job:submit" }` + `handle(CHANNELS.X, ...)`,
 * or via a stub registry (`stub_handlers.ts` STUB_CHANNELS entries).
 * For files that demonstrably register handlers, count every channel-shaped
 * string literal in the file as registered.
 */
const REGISTERS_HANDLERS_PATTERN =
  /ipcMain\.handle\(|createLoggedHandler\(|createTestOnlyLoggedHandler\(/;
const CHANNEL_LITERAL_PATTERN = /["'`]([a-z][a-zA-Z0-9_.-]*:[a-zA-Z0-9:_.-]+)["'`]/g;

function walkTsFiles(dir: string, out: string[] = []): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      walkTsFiles(full, out);
    } else if (
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".spec.ts") &&
      !entry.name.endsWith(".d.ts")
    ) {
      out.push(full);
    }
  }
  return out;
}

function getPreloadInvokeChannels(): string[] {
  const preload = fs.readFileSync(path.join(ROOT, "src", "preload.ts"), "utf8");
  const arrayMatch = preload.match(
    /const validInvokeChannels = \[([\s\S]*?)\]\s*(?:as const)?\s*;/,
  );
  expect(arrayMatch, "validInvokeChannels array not found in preload.ts").toBeTruthy();
  // Strip line comments so channel-shaped strings in comments aren't counted.
  const arrayBody = arrayMatch![1].replace(/\/\/.*$/gm, "");
  const channels = [...arrayBody.matchAll(/["'`]([^"'`]+)["'`]/g)].map(
    (m) => m[1],
  );
  expect(channels.length).toBeGreaterThan(100);
  return channels;
}

function getRegisteredChannels(): Set<string> {
  const files = [
    ...MAIN_PROCESS_DIRS.flatMap((d) => walkTsFiles(path.join(ROOT, d))),
    ...MAIN_PROCESS_FILES.map((f) => path.join(ROOT, f)),
  ];
  const registered = new Set<string>();
  for (const file of files) {
    let content: string;
    try {
      content = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const match of content.matchAll(REGISTRATION_PATTERN)) {
      registered.add(match[1]);
    }
    if (REGISTERS_HANDLERS_PATTERN.test(content)) {
      for (const match of content.matchAll(CHANNEL_LITERAL_PATTERN)) {
        registered.add(match[1]);
      }
    }
  }
  return registered;
}

describe("IPC channel parity", () => {
  it("every preload validInvokeChannel has a main-process handler registration", () => {
    const channels = getPreloadInvokeChannels();
    const registered = getRegisteredChannels();

    const dead = channels.filter((c) => !registered.has(c));

    expect(
      dead,
      `The following channels are exposed in preload.ts validInvokeChannels but have NO ipcMain.handle registration in main-process code (they will crash at runtime when invoked):\n${dead.join("\n")}`,
    ).toEqual([]);
  });
});
