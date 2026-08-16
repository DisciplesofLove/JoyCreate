import { useMemo } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { useVersionDiff } from "@/hooks/useVersionDiff";
import type { GitDiffFile } from "@/ipc/ipc_types";
import { cn } from "@/lib/utils";
import { Loader2, FilePlus, FileMinus, FilePen, FileClock } from "lucide-react";

interface VersionDiffDialogProps {
  appId: number | null;
  versionId: string | null;
  versionLabel?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function statusIcon(status: GitDiffFile["status"]) {
  switch (status) {
    case "added":
      return <FilePlus size={14} className="text-green-600" />;
    case "deleted":
      return <FileMinus size={14} className="text-red-600" />;
    case "renamed":
      return <FileClock size={14} className="text-blue-600" />;
    default:
      return <FilePen size={14} className="text-amber-600" />;
  }
}

/** Split a unified diff patch into lines classified for coloring. */
function renderPatch(patch: string) {
  const lines = patch.split("\n");
  return lines.map((line, i) => {
    let cls = "text-foreground/80";
    if (line.startsWith("+++") || line.startsWith("---")) {
      cls = "text-muted-foreground font-semibold";
    } else if (line.startsWith("@@")) {
      cls = "text-blue-600 dark:text-blue-400 font-semibold";
    } else if (line.startsWith("diff ") || line.startsWith("index ")) {
      cls = "text-muted-foreground";
    } else if (line.startsWith("+")) {
      cls =
        "text-green-700 dark:text-green-300 bg-green-500/10";
    } else if (line.startsWith("-")) {
      cls = "text-red-700 dark:text-red-300 bg-red-500/10";
    }
    return (
      <div key={i} className={cn("whitespace-pre-wrap px-2", cls)}>
        {line || "\u00A0"}
      </div>
    );
  });
}

export function VersionDiffDialog({
  appId,
  versionId,
  versionLabel,
  open,
  onOpenChange,
}: VersionDiffDialogProps) {
  const { data, isLoading, error } = useVersionDiff(appId, versionId, open);

  const patchNodes = useMemo(
    () => (data?.patch ? renderPatch(data.patch) : null),
    [data?.patch],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>
            Changes in {versionLabel ?? "this version"}
          </DialogTitle>
          <DialogDescription>
            {data
              ? `${data.files.length} file(s) changed, +${data.insertions} / -${data.deletions}`
              : "Loading diff..."}
          </DialogDescription>
        </DialogHeader>

        {isLoading && (
          <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
            <Loader2 size={16} className="animate-spin" />
            Loading diff...
          </div>
        )}

        {error && (
          <div className="p-4 text-sm text-red-600">
            Failed to load diff: {error.message}
          </div>
        )}

        {data && !isLoading && (
          <div className="flex-1 overflow-hidden flex flex-col gap-3">
            {data.files.length === 0 ? (
              <div className="p-4 text-sm text-muted-foreground">
                No changes in this version.
              </div>
            ) : (
              <>
                <div className="flex flex-col gap-1 border border-border rounded-md p-2 max-h-40 overflow-y-auto">
                  {data.files.map((f) => (
                    <div
                      key={f.path}
                      className="flex items-center gap-2 text-xs"
                    >
                      {statusIcon(f.status)}
                      <span className="font-mono truncate flex-1">
                        {f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}
                      </span>
                      {!f.binary && (
                        <span className="text-green-600">+{f.insertions}</span>
                      )}
                      {!f.binary && (
                        <span className="text-red-600">-{f.deletions}</span>
                      )}
                      {f.binary && (
                        <span className="text-muted-foreground">binary</span>
                      )}
                    </div>
                  ))}
                </div>
                <div className="flex-1 overflow-auto border border-border rounded-md bg-muted/30 font-mono text-xs py-1">
                  {patchNodes}
                </div>
              </>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
