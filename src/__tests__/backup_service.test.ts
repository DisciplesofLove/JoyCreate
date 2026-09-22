/**
 * Backup is only ever exercised on the day something has already gone wrong,
 * by someone who is trusting the list. These tests pin the properties that make
 * that trust reasonable.
 *
 * The dangerous cases are not "does it copy a file":
 *
 *   - a half-written snapshot must not appear as a usable backup, because a
 *     backup that looks fine and is not is worse than none at all;
 *   - a restore must verify the snapshot against its recorded hash before
 *     staging it, or a corrupt file silently becomes the live database;
 *   - a restore must never overwrite in place while the process holds the
 *     database open, and must keep a copy of what it replaced;
 *   - the snapshots the app already takes on version upgrade must be listed as
 *     restorable, not as corrupt — they are the safety net that actually exists.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

const { state } = vi.hoisted(() => ({
  state: { userData: "", dbPath: "" },
}));

vi.mock("electron-log", () => ({
  default: {
    scope: () => ({
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    }),
  },
}));

vi.mock("@/paths/paths", () => ({
  getUserDataPath: () => state.userData,
}));

// `VACUUM INTO` is the real snapshot mechanism; the fake writes the same bytes
// so the hash-verification path is exercised for real rather than stubbed.
vi.mock("@/db", () => ({
  getDatabasePath: () => state.dbPath,
  getDb: () => ({
    $client: {
      prepare: (sql: string) => ({
        run: (target: string) => {
          if (!sql.includes("VACUUM INTO")) throw new Error(`unexpected sql: ${sql}`);
          fs.copyFileSync(state.dbPath, target);
        },
      }),
    },
  }),
}));

import {
  applyPendingRestoreAtBoot,
  cancelPendingRestore,
  createBackup,
  deleteBackup,
  getBackupDir,
  getPendingRestore,
  listBackups,
  restoreBackup,
} from "@/lib/backup_service";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "joy-backup-"));
  state.userData = tmp;
  state.dbPath = path.join(tmp, "sqlite.db");
  fs.writeFileSync(state.dbPath, "ORIGINAL DATABASE");
  fs.writeFileSync(path.join(tmp, "settings.json"), '{"theme":"dark"}');
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("creating a snapshot", () => {
  it("captures the database and reports what it captured", async () => {
    const made = await createBackup({ kind: "database", name: "probe" });

    expect(made.includes).toEqual(["database"]);
    expect(made.name).toBe("probe");
    expect(made.sizeBytes).toBeGreaterThan(0);
    expect(
      fs.readFileSync(path.join(getBackupDir(), made.id, "sqlite.db"), "utf8"),
    ).toBe("ORIGINAL DATABASE");
  });

  it("records a hash of the database it wrote", async () => {
    const made = await createBackup({ kind: "database" });
    const expected = createHash("sha256").update("ORIGINAL DATABASE").digest("hex");
    expect(made.databaseSha256).toBe(expected);
  });

  it("includes config when asked for config only, and no database", async () => {
    const made = await createBackup({ kind: "config" });
    expect(made.includes).toEqual(["config"]);
    expect(fs.existsSync(path.join(getBackupDir(), made.id, "sqlite.db"))).toBe(false);
  });

  it("removes the directory when a snapshot fails partway", async () => {
    // A snapshot that dies mid-write must not be left behind: it would list as
    // a backup and restore as nothing.
    const before = listBackups().length;
    // Point the database at a path that does not exist so the copy throws.
    state.dbPath = path.join(tmp, "missing.db");

    await expect(createBackup({ kind: "database" })).rejects.toThrow();
    expect(listBackups().length).toBe(before);
  });
});

describe("listing snapshots", () => {
  it("lists newest first", async () => {
    const a = await createBackup({ kind: "database", name: "older" });
    // Ids embed an ISO timestamp; nudge the second one so ordering is decidable.
    await new Promise((r) => setTimeout(r, 5));
    const b = await createBackup({ kind: "database", name: "newer" });

    const ids = listBackups().map((x) => x.id);
    expect(ids.indexOf(b.id)).toBeLessThan(ids.indexOf(a.id));
  });

  it("reads the upgrade-time snapshots the app already takes", async () => {
    // `src/backup_manager.ts` has been writing these since long before this
    // service existed. Listing only this service's own manifest would report a
    // genuine, restorable safety net as corrupt.
    const dir = path.join(getBackupDir(), "v1.2.3_2026-01-01_upgrade_from_1.2.2");
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(state.dbPath, path.join(dir, "sqlite.db"));
    fs.writeFileSync(
      path.join(dir, "backup.json"),
      JSON.stringify({
        version: "1.2.3",
        timestamp: "2026-01-01T00:00:00.000Z",
        reason: "upgrade_from_1.2.2",
        files: { settings: false, database: true },
        checksums: {
          settings: null,
          database: createHash("sha256").update("ORIGINAL DATABASE").digest("hex"),
        },
      }),
    );

    const [entry] = listBackups().filter((b) => b.legacy);
    expect(entry).toBeDefined();
    expect(entry.includes).toContain("database");
    expect(entry.error).toBeUndefined();
    expect(entry.appVersion).toBe("1.2.3");
  });

  it("flags a directory with no metadata rather than hiding it", async () => {
    fs.mkdirSync(path.join(getBackupDir(), "half-written"), { recursive: true });
    const entry = listBackups().find((b) => b.id === "half-written");
    expect(entry?.error).toMatch(/incomplete/i);
  });
});

describe("restoring", () => {
  it("stages rather than overwriting the live database", async () => {
    const made = await createBackup({ kind: "database" });
    fs.writeFileSync(state.dbPath, "CHANGED SINCE BACKUP");

    const result = await restoreBackup(made.id);

    expect(result.requiresRestart).toBe(true);
    // The live file is untouched until the next boot — the process is holding
    // it open, and swapping it underneath a live connection corrupts both.
    expect(fs.readFileSync(state.dbPath, "utf8")).toBe("CHANGED SINCE BACKUP");
    expect(getPendingRestore()?.backupId).toBe(made.id);
  });

  it("backs up the current database before staging", async () => {
    const made = await createBackup({ kind: "database" });
    fs.writeFileSync(state.dbPath, "CHANGED SINCE BACKUP");

    const result = await restoreBackup(made.id);

    // Restoring the wrong snapshot should not be a one-way door.
    const safety = listBackups().find((b) => b.id === result.preRestoreBackupId);
    expect(safety).toBeDefined();
    expect(
      fs.readFileSync(path.join(getBackupDir(), safety!.id, "sqlite.db"), "utf8"),
    ).toBe("CHANGED SINCE BACKUP");
  });

  it("refuses a snapshot whose database does not match its hash", async () => {
    const made = await createBackup({ kind: "database" });
    fs.writeFileSync(path.join(getBackupDir(), made.id, "sqlite.db"), "TAMPERED");

    await expect(restoreBackup(made.id)).rejects.toThrow(/corrupt/i);
    expect(getPendingRestore()).toBeNull();
  });

  it("refuses a snapshot that holds no database", async () => {
    const made = await createBackup({ kind: "config" });
    await expect(restoreBackup(made.id)).rejects.toThrow(/no database/i);
  });

  it("applies the staged restore at boot and keeps what it replaced", async () => {
    const made = await createBackup({ kind: "database" });
    fs.writeFileSync(state.dbPath, "CHANGED SINCE BACKUP");
    await restoreBackup(made.id);

    expect(applyPendingRestoreAtBoot()).toBe(true);

    expect(fs.readFileSync(state.dbPath, "utf8")).toBe("ORIGINAL DATABASE");
    // The displaced database is kept, not deleted.
    const displaced = fs
      .readdirSync(tmp)
      .filter((f) => f.startsWith("sqlite.db.replaced-"));
    expect(displaced).toHaveLength(1);
    expect(fs.readFileSync(path.join(tmp, displaced[0]), "utf8")).toBe(
      "CHANGED SINCE BACKUP",
    );
  });

  it("does nothing at boot when no restore was staged", () => {
    expect(applyPendingRestoreAtBoot()).toBe(false);
    expect(fs.readFileSync(state.dbPath, "utf8")).toBe("ORIGINAL DATABASE");
  });

  it("does not reapply a restore on the next boot", async () => {
    const made = await createBackup({ kind: "database" });
    await restoreBackup(made.id);
    applyPendingRestoreAtBoot();

    fs.writeFileSync(state.dbPath, "WORK DONE AFTER THE RESTORE");
    expect(applyPendingRestoreAtBoot()).toBe(false);
    expect(fs.readFileSync(state.dbPath, "utf8")).toBe("WORK DONE AFTER THE RESTORE");
  });

  it("can cancel a staged restore before it is applied", async () => {
    const made = await createBackup({ kind: "database" });
    await restoreBackup(made.id);

    expect(cancelPendingRestore()).toBe(true);
    expect(getPendingRestore()).toBeNull();
    expect(applyPendingRestoreAtBoot()).toBe(false);
  });
});

describe("deleting", () => {
  it("removes a snapshot", async () => {
    const made = await createBackup({ kind: "database" });
    deleteBackup(made.id);
    expect(listBackups().find((b) => b.id === made.id)).toBeUndefined();
  });

  it("refuses an id that escapes the backup directory", () => {
    // The id reaches this from the renderer; a traversal would delete anything
    // the app can write.
    expect(() => deleteBackup("../../sqlite.db")).toThrow();
    expect(fs.existsSync(state.dbPath)).toBe(true);
  });
});
