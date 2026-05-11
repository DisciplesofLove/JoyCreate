/**
 * Encrypted session vault for the Left Gauntlet.
 *
 * Persisted Chromium sessions live under `userData/Partitions/gauntlet-<id>/`
 * (managed by Electron itself). This module persists *metadata* (label,
 * origin pattern) and exposes helpers to capture/restore cookies into a
 * brand-new partition, encrypted with Electron `safeStorage` so the cookie
 * jar can't be lifted off disk in plain text.
 */

import { safeStorage, type Cookie } from "electron";
import path from "node:path";
import fs from "node:fs/promises";
import { getUserDataPath } from "@/paths/paths";

interface VaultBundle {
  cookies: Cookie[];
  capturedAt: number;
}

function vaultDir(): string {
  return path.join(getUserDataPath(), "gauntlet", "sessions");
}

function vaultPath(sessionId: string): string {
  return path.join(vaultDir(), `${sessionId}.bin`);
}

async function ensureDir(): Promise<void> {
  await fs.mkdir(vaultDir(), { recursive: true });
}

export async function saveCookieJar(
  sessionId: string,
  cookies: Cookie[],
): Promise<void> {
  await ensureDir();
  const bundle: VaultBundle = { cookies, capturedAt: Date.now() };
  const json = JSON.stringify(bundle);
  const buf = safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(json)
    : Buffer.from(json, "utf-8");
  await fs.writeFile(vaultPath(sessionId), buf);
}

export async function loadCookieJar(
  sessionId: string,
): Promise<VaultBundle | null> {
  const p = vaultPath(sessionId);
  try {
    const raw = await fs.readFile(p);
    const text = safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(raw)
      : raw.toString("utf-8");
    return JSON.parse(text) as VaultBundle;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function deleteCookieJar(sessionId: string): Promise<void> {
  try {
    await fs.unlink(vaultPath(sessionId));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}
