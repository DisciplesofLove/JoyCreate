/**
 * Backup & Restore Page
 *
 * Real snapshots of the local database and userData, from `backup:*`.
 *
 * This page previously listed four invented backups ("Daily Backup, 2.1 GB")
 * and its two buttons raised "Starting backup..." and "Restoring from ..."
 * without touching disk. Backup is the one feature where a convincing mockup is
 * actively dangerous: it is only ever exercised on the day something has gone
 * wrong, by someone who believed the list.
 *
 * The schedule controls are gone rather than left inert. There is no scheduler
 * behind them, and a switch labelled "Enable Auto-Backup" that does nothing is
 * the same lie in a smaller box. What the app genuinely does — snapshot on every
 * version upgrade — is stated instead, and those snapshots appear in the list.
 */

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import {
  Archive,
  Upload,
  CheckCircle2,
  Database,
  Trash2,
  RefreshCw,
  AlertTriangle,
  Loader2,
  FolderOpen,
  Info,
} from "lucide-react";

import { IpcClient } from "@/ipc/ipc_client";
import type {
  BackupEntry,
  BackupKind,
  PendingRestore,
} from "@/ipc/ipc_client";

function formatBytes(n: number): string {
  if (!n) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const KIND_LABEL: Record<BackupKind, string> = {
  full: "Full",
  database: "Database",
  config: "Config",
};

export default function BackupRestorePage() {
  const [backups, setBackups] = useState<BackupEntry[]>([]);
  const [pending, setPending] = useState<PendingRestore | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [kind, setKind] = useState<BackupKind>("full");

  const ipc = IpcClient.getInstance();

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const [list, restore] = await Promise.all([
        ipc.listBackups(),
        ipc.getPendingRestore(),
      ]);
      setBackups(list ?? []);
      setPending(restore ?? null);
    } catch (err) {
      setLoadError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [ipc]);

  useEffect(() => {
    void load();
  }, [load]);

  const onCreate = async () => {
    setCreating(true);
    try {
      // A full snapshot copies generated media as well as the database, so it
      // can take a while on a large profile. The button stays disabled with a
      // spinner rather than firing a toast and returning immediately, because
      // "backup started" and "backup finished" are not the same claim.
      const made = await ipc.createBackup({ kind });
      toast.success(`Backup created — ${formatBytes(made.sizeBytes)}`, {
        description: made.includes.join(", ") || "nothing captured",
      });
      await load();
    } catch (err) {
      toast.error(`Backup failed: ${errorMessage(err)}`);
    } finally {
      setCreating(false);
    }
  };

  const onRestore = async (backup: BackupEntry) => {
    if (
      !window.confirm(
        `Restore "${backup.name}"?\n\n` +
          `Your current database will be backed up first, then replaced when JoyCreate next starts. ` +
          `Anything created since ${new Date(backup.createdAt).toLocaleString()} will not be in the restored copy.`,
      )
    ) {
      return;
    }
    setBusyId(backup.id);
    try {
      await ipc.restoreBackup(backup.id);
      toast.success("Restore staged — restart JoyCreate to apply it", {
        duration: 10000,
      });
      await load();
    } catch (err) {
      toast.error(`Restore failed: ${errorMessage(err)}`);
    } finally {
      setBusyId(null);
    }
  };

  const onDelete = async (backup: BackupEntry) => {
    if (!window.confirm(`Delete "${backup.name}"? This cannot be undone.`)) return;
    setBusyId(backup.id);
    try {
      await ipc.deleteBackup(backup.id);
      toast.success("Backup deleted");
      await load();
    } catch (err) {
      toast.error(`Delete failed: ${errorMessage(err)}`);
    } finally {
      setBusyId(null);
    }
  };

  const onReveal = async (id?: string) => {
    try {
      await ipc.revealBackup(id);
    } catch (err) {
      toast.error(`Could not open folder: ${errorMessage(err)}`);
    }
  };

  const onCancelRestore = async () => {
    try {
      await ipc.cancelPendingRestore();
      toast.success("Staged restore cancelled");
      await load();
    } catch (err) {
      toast.error(`Could not cancel: ${errorMessage(err)}`);
    }
  };

  return (
    <div className="h-full flex flex-col">
      <div className="border-b p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-blue-500 to-cyan-600 flex items-center justify-center">
              <Archive className="w-5 h-5 text-white" />
            </div>
            <div>
              <h1 className="text-xl font-semibold">Backup &amp; Restore</h1>
              <p className="text-sm text-muted-foreground">
                Snapshots of your local database and files
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Select value={kind} onValueChange={(v) => setKind(v as BackupKind)}>
              <SelectTrigger className="w-[190px] h-9 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="full">Full — database + files</SelectItem>
                <SelectItem value="database">Database only</SelectItem>
                <SelectItem value="config">Config only</SelectItem>
              </SelectContent>
            </Select>
            <Button onClick={() => void onCreate()} disabled={creating}>
              {creating ? (
                <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
              ) : (
                <Archive className="w-4 h-4 mr-1.5" />
              )}
              {creating ? "Backing up…" : "Create Backup Now"}
            </Button>
          </div>
        </div>
      </div>

      <ScrollArea className="flex-1 p-4">
        {pending && (
          <Card className="bg-amber-500/5 border-amber-500/30 mb-6">
            <CardContent className="p-4 flex items-center gap-3">
              <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0" />
              <div className="flex-1">
                <p className="text-sm font-medium">Restore pending</p>
                <p className="text-xs text-muted-foreground">
                  A restore of <span className="font-mono">{pending.backupId}</span>{" "}
                  was staged{" "}
                  {new Date(pending.requestedAt).toLocaleString()}. It applies the
                  next time JoyCreate starts.
                </p>
              </div>
              <Button size="sm" variant="outline" onClick={() => void onCancelRestore()}>
                Cancel
              </Button>
            </CardContent>
          </Card>
        )}

        <Card className="bg-muted/10 border-border/30 mb-6">
          <CardHeader className="py-3 px-4">
            <CardTitle className="text-sm flex items-center gap-2">
              <Info className="w-3.5 h-3.5" /> What gets captured
            </CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-4 space-y-2 text-xs text-muted-foreground">
            <p>
              A <strong>full</strong> backup copies <code>sqlite.db</code> — agents,
              apps, documents, datasets, contracts and the activity log — plus your
              settings and generated media. <strong>Database only</strong> skips the
              media, which is most of the size.
            </p>
            <p>
              JoyCreate also snapshots automatically whenever it starts after a
              version upgrade. Those appear below marked{" "}
              <Badge variant="outline" className="text-[9px]">
                upgrade
              </Badge>
              . There is no scheduled backup — create one before anything risky.
            </p>
            <Button
              size="sm"
              variant="outline"
              className="mt-1"
              onClick={() => void onReveal()}
            >
              <FolderOpen className="w-3.5 h-3.5 mr-1" /> Open backups folder
            </Button>
          </CardContent>
        </Card>

        <h3 className="text-sm font-semibold mb-3">
          Backup History
          {!loading && (
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              {backups.length} snapshot{backups.length === 1 ? "" : "s"}
            </span>
          )}
        </h3>

        {loading ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground py-6">
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> Reading backups…
          </div>
        ) : loadError ? (
          <Card className="bg-red-500/5 border-red-500/20">
            <CardContent className="p-4 space-y-2">
              <p className="text-sm text-red-400">Could not read backups</p>
              <p className="text-xs font-mono text-muted-foreground">{loadError}</p>
              <Button size="sm" variant="outline" onClick={() => void load()}>
                <RefreshCw className="w-3.5 h-3.5 mr-1" /> Retry
              </Button>
            </CardContent>
          </Card>
        ) : backups.length === 0 ? (
          <Card className="bg-muted/10 border-border/30">
            <CardContent className="p-6 text-center space-y-1">
              <Database className="w-6 h-6 mx-auto text-muted-foreground/40" />
              <p className="text-sm">No backups yet</p>
              <p className="text-xs text-muted-foreground">
                Nothing has been snapshotted on this machine. Create one now.
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-2">
            {backups.map((backup) => {
              const broken = !!backup.error;
              const restorable = backup.includes.includes("database");
              return (
                <Card key={backup.id} className="bg-muted/10 border-border/30">
                  <CardContent className="p-3 flex items-center gap-4">
                    <div className="w-10 h-10 rounded-xl bg-blue-500/10 flex items-center justify-center shrink-0">
                      {broken ? (
                        <AlertTriangle className="w-5 h-5 text-red-400" />
                      ) : (
                        <CheckCircle2 className="w-5 h-5 text-green-400" />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium">{backup.name}</span>
                        <Badge variant="outline" className="text-[9px]">
                          {KIND_LABEL[backup.kind]}
                        </Badge>
                        {backup.legacy && (
                          <Badge variant="outline" className="text-[9px]">
                            upgrade
                          </Badge>
                        )}
                      </div>
                      <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                        <span className="text-[10px] text-muted-foreground/50">
                          {new Date(backup.createdAt).toLocaleString()}
                        </span>
                        <span className="text-[10px] text-muted-foreground/50">•</span>
                        <span className="text-[10px] text-muted-foreground/50">
                          {formatBytes(backup.sizeBytes)}
                        </span>
                        {backup.includes.length > 0 && (
                          <>
                            <span className="text-[10px] text-muted-foreground/50">•</span>
                            <span className="text-[10px] text-muted-foreground/50">
                              {backup.includes.join(", ")}
                            </span>
                          </>
                        )}
                        {backup.error && (
                          <span className="text-[10px] text-red-400">{backup.error}</span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      {/* A config-only snapshot has no database to restore, so
                          the button is absent rather than present-and-failing. */}
                      {restorable && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 text-[10px]"
                          disabled={busyId === backup.id}
                          onClick={() => void onRestore(backup)}
                        >
                          <Upload className="w-3 h-3 mr-0.5" /> Restore
                        </Button>
                      )}
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 text-[10px]"
                        onClick={() => void onReveal(backup.id)}
                      >
                        <FolderOpen className="w-3 h-3 mr-0.5" /> Show
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 p-0 text-muted-foreground/50 hover:text-red-400"
                        disabled={busyId === backup.id}
                        onClick={() => void onDelete(backup)}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}
