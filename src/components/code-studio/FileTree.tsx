/**
 * File Tree Component for Code Studio
 */

import { useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  File,
  Folder,
  FolderOpen,
  RefreshCw,
  AlertCircle,
} from "lucide-react";
import { type FsEntry } from "@/ipc/code_studio_client";
import { useDirListing } from "@/hooks/useCodeStudio";
import { useQueryClient } from "@tanstack/react-query";
import { cn } from "@/lib/utils";

interface FileTreeProps {
  selected: string | null;
  onSelect: (relPath: string) => void;
}

export function FileTree({ selected, onSelect }: FileTreeProps) {
  const qc = useQueryClient();
  return (
    <div className="text-xs font-mono select-none p-1">
      <div className="flex items-center justify-between px-1.5 py-1">
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
          Explorer
        </span>
        <button
          type="button"
          title="Refresh"
          className="p-0.5 rounded hover:bg-accent text-muted-foreground"
          onClick={() => qc.invalidateQueries({ queryKey: ["code-studio"] })}
        >
          <RefreshCw className="h-3 w-3" />
        </button>
      </div>
      <FileTreeNode
        relPath=""
        depth={0}
        expandedByDefault
        selected={selected}
        onSelect={onSelect}
      />
    </div>
  );
}

interface NodeProps {
  relPath: string;
  depth: number;
  expandedByDefault?: boolean;
  selected: string | null;
  onSelect: (relPath: string) => void;
}

function FileTreeNode({
  relPath,
  depth,
  expandedByDefault,
  selected,
  onSelect,
}: NodeProps) {
  const [expanded] = useState(!!expandedByDefault);
  const { data: entries, isLoading, error } = useDirListing(relPath, expanded);

  if (error) {
    return (
      <div
        style={{ paddingLeft: depth * 12 + 16 }}
        className="text-rose-500 py-0.5 flex items-center gap-1"
        title={(error as Error).message}
      >
        <AlertCircle className="h-3 w-3 shrink-0" />
        <span className="truncate">{(error as Error).message}</span>
      </div>
    );
  }

  if (isLoading && expanded) {
    return (
      <div
        style={{ paddingLeft: depth * 12 + 16 }}
        className="text-muted-foreground py-0.5"
      >
        loading…
      </div>
    );
  }

  if (entries && entries.length === 0) {
    return (
      <div
        style={{ paddingLeft: depth * 12 + 16 }}
        className="text-muted-foreground/60 py-0.5 italic"
      >
        (empty)
      </div>
    );
  }

  return (
    <div>
      {entries?.map((entry) => (
        <FileTreeRow
          key={entry.path}
          entry={entry}
          depth={depth}
          selected={selected}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}

interface RowProps {
  entry: FsEntry;
  depth: number;
  selected: string | null;
  onSelect: (relPath: string) => void;
}

function FileTreeRow({ entry, depth, selected, onSelect }: RowProps) {
  const [expanded, setExpanded] = useState(false);
  const isSelected = selected === entry.relPath;

  if (entry.type === "directory") {
    return (
      <div>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="w-full flex items-center gap-1 hover:bg-accent/50 rounded-sm py-0.5 text-left"
          style={{ paddingLeft: depth * 12 + 4 }}
        >
          {expanded ? (
            <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
          )}
          {expanded ? (
            <FolderOpen className="h-3.5 w-3.5 shrink-0 text-blue-500" />
          ) : (
            <Folder className="h-3.5 w-3.5 shrink-0 text-blue-500" />
          )}
          <span className="truncate">{entry.name}</span>
        </button>
        {expanded && (
          <FileTreeNode
            relPath={entry.relPath}
            depth={depth + 1}
            selected={selected}
            onSelect={onSelect}
          />
        )}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => onSelect(entry.relPath)}
      className={cn(
        "w-full flex items-center gap-1 rounded-sm py-0.5 text-left",
        isSelected ? "bg-primary/15 text-primary" : "hover:bg-accent/50",
      )}
      style={{ paddingLeft: depth * 12 + 16 }}
    >
      <File className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <span className="truncate">{entry.name}</span>
    </button>
  );
}
