/**
 * Local backup and restore.
 *
 * The Backup & Restore page shipped as a mockup — four invented snapshots and
 * two buttons that raised "Starting backup..." and "Restoring from ..." without
 * touching disk. That is the worst possible failure mode for this particular
 * feature: someone reads "backup completed", trusts it, and finds out it was
 * decoration only when they need to restore.
 *
 * What a backup means here
 * ------------------------
 * Everything JoyCreate owns lives under `userData`: `sqlite.db` holds agents,
 * apps, documents, datasets, contracts and the activity log; `settings.json`
 * holds provider keys and preferences; loose directories hold generated media.
 * A backup is a snapshot of the database plus, optionally, those directories.
 *
 * The database is copied with SQLite's own online backup API rather than a file
 * copy. A plain `copyFile` of a live database can capture a torn page — the
 * copy looks fine until the day you restore it — whereas `VACUUM INTO`
 * serialises against writers and always produces a consistent, already-compact
 * file.
 *
 * Restores never overwrite in place
 * --------------------------------
 * Restoring writes the recovered database to a staging path and asks the app to
 * swap it on next start, after moving the current database aside. The running
 * process holds an open handle to `sqlite.db`; replacing it underneath a live
 * connection on Windows either fails outright or corrupts both. The pre-restore
 * copy is kept, so a restore of the wrong snapshot is itself undoable.
 */

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import log from "electron-log";

import { getUserDataPath } from "@/paths/paths";
import { getDatabasePath, getDb } from "@/db";

const logger = log.scope("backup");

/** Where snapshots live. Kept inside userData so it travels with the profile. */
export function getBackupDir(): string {
  return path.join(getUserDataPath(), "backups");
}

/** Marker read at boot: a restore staged by a previous run. */
export function getPendingRestorePath(): string {
  return path.join(getBackupDir(), "PENDING_RESTORE.json");
}

export type BackupKind = "full" | "database" | "config";

export interface BackupEntry {
  id: string;
  name: string;
  kind: BackupKind;
  createdAt: string;
  sizeBytes: number;
  /** Which parts made it in — reported, never assumed. */
  includes: string[];
  /** SHA-256 of the database file, so a restore can prove what it restored. */
  databaseSha256?: string;
  appVersion?: string;
  /** True for snapshots taken automatically on a version upgrade. */
  legacy?: boolean;
  error?: string;
}

interface BackupManifest extends BackupEntry {
  files: string[];
  /** True for snapshots written by the upgrade-time `BackupManager`. */
  legacy?: boolean;
}

/** Directories under userData worth capturing in a full backup. */
const CONTENT_DIRS = [
  "documents",
  "images",
  "videos",
  "datasets",
  "models",
  "celestia-blobs",
];

const CONFIG_FILES = ["settings.json", "user-settings.json"];

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function dirSize(dir: string): number {
  let total = 0;
  if (!fs.existsSync(dir)) return 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    try {
      total += entry.isDirectory() ? dirSize(p) : fs.statSync(p).size;
    } catch {
      // A file that vanished mid-walk should not fail the whole measurement.
    }
  }
  return total;
}

function copyDir(src: string, dest: string): void {
  if (!fs.existsSync(src)) return;
  ensureDir(dest);
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else fs.copyFileSync(from, to);
  }
}

function sha256File(file: string): string {
  const hash = createHash("sha256");
  hash.update(fs.readFileSync(file));
  return hash.digest("hex");
}

function manifestPath(id: string): string {
  return path.join(getBackupDir(), id, "manifest.json");
}

/**
 * Metadata written by `src/backup_manager.ts`, which has been taking a
 * snapshot on every version upgrade into this same directory since long before
 * this service existed.
 */
interface LegacyBackupMeta {
  version: string;
  timestamp: string;
  reason: string;
  files: { settings: boolean; database: boolean };
  checksums: { settings: string | null; database: string | null };
}

/**
 * Read a snapshot's metadata, in either format.
 *
 * The upgrade backups are real, restorable snapshots — they hold the same
 * `sqlite.db` and `settings.json`. Reading only this service's own manifest
 * would have listed every one of them as "incomplete", telling the user their
 * genuine safety net was corrupt.
 */
function readManifest(id: string): BackupManifest | null {
  const dir = path.join(getBackupDir(), id);
  try {
    return JSON.parse(fs.readFileSync(manifestPath(id), "utf8")) as BackupManifest;
  } catch {
    /* fall through to the legacy shape */
  }

  try {
    const legacy = JSON.parse(
      fs.readFileSync(path.join(dir, "backup.json"), "utf8"),
    ) as LegacyBackupMeta;

    const includes: string[] = [];
    const files: string[] = [];
    if (legacy.files?.database) {
      includes.push("database");
      files.push("sqlite.db");
    }
    if (legacy.files?.settings) {
      includes.push("config");
      files.push("settings.json");
    }

    return {
      id,
      name: `${legacy.reason.replace(/_/g, " ")} (v${legacy.version})`,
      kind: legacy.files?.database ? "full" : "config",
      createdAt: legacy.timestamp,
      sizeBytes: dirSize(dir),
      includes,
      // The legacy checksum is over the same file, so a restore of one of these
      // is verified exactly like a new snapshot.
      databaseSha256: legacy.checksums?.database ?? undefined,
      appVersion: legacy.version,
      files,
      legacy: true,
    };
  } catch {
    return null;
  }
}

// ── create ───────────────────────────────────────────────────────────────────

export interface CreateBackupInput {
  name?: string;
  kind?: BackupKind;
}

export async function createBackup(
  input: CreateBackupInput = {},
): Promise<BackupEntry> {
  const kind = input.kind ?? "full";
  const createdAt = new Date();
  const id = `${createdAt.toISOString().replace(/[:.]/g, "-")}-${kind}`;
  const dir = path.join(getBackupDir(), id);
  ensureDir(dir);

  const includes: string[] = [];
  const files: string[] = [];

  try {
    if (kind === "full" || kind === "database") {
      const target = path.join(dir, "sqlite.db");
      // `VACUUM INTO` takes SQLite's own consistent snapshot of a live
      // database. A file copy here would race the writers this app runs
      // constantly (the supervisor tick, any agent run) and could capture a
      // torn page that only reveals itself on restore.
      const sqlite = (getDb() as unknown as { $client: { prepare: (s: string) => { run: (...a: unknown[]) => unknown } } }).$client;
      sqlite.prepare("VACUUM INTO ?").run(target);
      includes.push("database");
      files.push("sqlite.db");
    }

    if (kind === "full" || kind === "config") {
      const userData = getUserDataPath();
      for (const f of CONFIG_FILES) {
        const src = path.join(userData, f);
        if (fs.existsSync(src)) {
          fs.copyFileSync(src, path.join(dir, f));
          files.push(f);
          if (!includes.includes("config")) includes.push("config");
        }
      }
    }

    if (kind === "full") {
      const userData = getUserDataPath();
      for (const d of CONTENT_DIRS) {
        const src = path.join(userData, d);
        if (fs.existsSync(src)) {
          copyDir(src, path.join(dir, d));
          files.push(`${d}/`);
          includes.push(d);
        }
      }
    }

    const dbFile = path.join(dir, "sqlite.db");
    const manifest: BackupManifest = {
      id,
      name: input.name?.trim() || defaultName(kind, createdAt),
      kind,
      createdAt: createdAt.toISOString(),
      sizeBytes: dirSize(dir),
      includes,
      databaseSha256: fs.existsSync(dbFile) ? sha256File(dbFile) : undefined,
      appVersion: process.env.npm_package_version,
      files,
    };
    fs.writeFileSync(manifestPath(id), JSON.stringify(manifest, null, 2));
    logger.info(`backup ${id} created (${includes.join(", ") || "nothing"})`);
    return manifest;
  } catch (err) {
    // A half-written backup is more dangerous than none, because it looks like
    // a backup in the list. Remove it and report the failure.
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    logger.error(`backup ${id} failed`, err);
    throw err instanceof Error ? err : new Error(String(err));
  }
}

function defaultName(kind: BackupKind, at: Date): string {
  const label =
    kind === "full" ? "Full backup" : kind === "database" ? "Database" : "Config";
  return `${label} — ${at.toLocaleString()}`;
}

// ── list / delete ────────────────────────────────────────────────────────────

export function listBackups(): BackupEntry[] {
  const dir = getBackupDir();
  if (!fs.existsSync(dir)) return [];
  const out: BackupEntry[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const m = readManifest(entry.name);
    if (m) out.push(m);
    else {
      // A directory with no manifest is a backup that died partway. Surface it
      // rather than hiding it, so it can be deleted deliberately.
      out.push({
        id: entry.name,
        name: entry.name,
        kind: "full",
        createdAt: new Date(0).toISOString(),
        sizeBytes: dirSize(path.join(dir, entry.name)),
        includes: [],
        error: "incomplete — no manifest",
      });
    }
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function deleteBackup(id: string): void {
  const dir = path.join(getBackupDir(), id);
  if (!dir.startsWith(getBackupDir())) throw new Error("invalid backup id");
  if (!fs.existsSync(dir)) throw new Error(`Backup not found: ${id}`);
  fs.rmSync(dir, { recursive: true, force: true });
  logger.info(`backup ${id} deleted`);
}

// ── restore ──────────────────────────────────────────────────────────────────

export interface RestoreResult {
  staged: true;
  backupId: string;
  /** Copy of the current database, taken before anything was staged. */
  preRestoreBackupId: string;
  requiresRestart: true;
}

/**
 * Stage a restore. Nothing is swapped while the app is running.
 *
 * The current database is backed up first — restoring the wrong snapshot is an
 * easy mistake and it should not be a one-way door.
 */
export async function restoreBackup(id: string): Promise<RestoreResult> {
  const manifest = readManifest(id);
  if (!manifest) throw new Error(`Backup not found or incomplete: ${id}`);

  const source = path.join(getBackupDir(), id, "sqlite.db");
  if (!fs.existsSync(source)) {
    throw new Error(
      `Backup ${id} contains no database (includes: ${manifest.includes.join(", ") || "nothing"})`,
    );
  }

  if (manifest.databaseSha256) {
    const actual = sha256File(source);
    if (actual !== manifest.databaseSha256) {
      throw new Error(
        `Backup ${id} is corrupt: database hash does not match its manifest`,
      );
    }
  }

  const safety = await createBackup({
    kind: "database",
    name: `Before restoring ${manifest.name}`,
  });

  const staged = path.join(getBackupDir(), "STAGED_RESTORE.db");
  fs.copyFileSync(source, staged);

  fs.writeFileSync(
    getPendingRestorePath(),
    JSON.stringify(
      {
        backupId: id,
        stagedFile: staged,
        preRestoreBackupId: safety.id,
        requestedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );

  logger.info(`restore of ${id} staged; will apply on next start`);
  return {
    staged: true,
    backupId: id,
    preRestoreBackupId: safety.id,
    requiresRestart: true,
  };
}

/** Cancel a staged restore that has not been applied yet. */
export function cancelPendingRestore(): boolean {
  const marker = getPendingRestorePath();
  if (!fs.existsSync(marker)) return false;
  try {
    const { stagedFile } = JSON.parse(fs.readFileSync(marker, "utf8"));
    if (stagedFile && fs.existsSync(stagedFile)) fs.rmSync(stagedFile);
  } catch {
    /* the marker is going away regardless */
  }
  fs.rmSync(marker);
  return true;
}

export function getPendingRestore(): {
  backupId: string;
  requestedAt: string;
} | null {
  try {
    const marker = getPendingRestorePath();
    if (!fs.existsSync(marker)) return null;
    return JSON.parse(fs.readFileSync(marker, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Apply a staged restore. Called at boot, BEFORE the database is opened.
 *
 * Ordering matters: the live file is moved aside rather than deleted, and the
 * marker is removed last. A crash at any point leaves either the original
 * database or a marker that will retry — never a missing database.
 */
export function applyPendingRestoreAtBoot(): boolean {
  const marker = getPendingRestorePath();
  if (!fs.existsSync(marker)) return false;

  try {
    const { stagedFile, backupId } = JSON.parse(fs.readFileSync(marker, "utf8"));
    if (!stagedFile || !fs.existsSync(stagedFile)) {
      logger.warn("pending restore had no staged file; discarding marker");
      fs.rmSync(marker);
      return false;
    }

    const live = getDatabasePath();
    const displaced = `${live}.replaced-${Date.now()}`;
    if (fs.existsSync(live)) fs.renameSync(live, displaced);

    fs.copyFileSync(stagedFile, live);
    fs.rmSync(stagedFile);
    fs.rmSync(marker);

    logger.info(
      `restored database from backup ${backupId}; previous database kept at ${path.basename(displaced)}`,
    );
    return true;
  } catch (err) {
    logger.error("failed to apply pending restore", err);
    return false;
  }
}
