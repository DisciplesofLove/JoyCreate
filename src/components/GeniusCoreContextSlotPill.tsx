/**
 * Genius Core — per-project context slot status pill.
 *
 * Renders a compact badge with the project's current IPLD slot CID
 * (truncated bafk…hash) plus a tooltip showing base model + adapter
 * byte count. Click triggers a full open (which fires the
 * `genius_core.context_slot.loaded` domain event so downstream
 * subsystems light up).
 *
 * Drop into any project-header layout:
 * ```tsx
 * <GeniusCoreContextSlotPill projectId={String(project.id)} />
 * ```
 */

import React from "react";
import { Loader2, Sparkles, AlertCircle } from "lucide-react";

import {
  useGeniusCoreProjectSlot,
  useOpenGeniusCoreProjectSlot,
} from "@/hooks/useGeniusCore";

export interface GeniusCoreContextSlotPillProps {
  projectId: string;
  className?: string;
}

function shortenCid(cid: string): string {
  if (cid.length <= 12) return cid;
  return `${cid.slice(0, 6)}…${cid.slice(-4)}`;
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

export function GeniusCoreContextSlotPill({
  projectId,
  className,
}: GeniusCoreContextSlotPillProps): React.ReactElement | null {
  const peek = useGeniusCoreProjectSlot(projectId);
  const open = useOpenGeniusCoreProjectSlot();

  if (!projectId) return null;

  const base =
    "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium select-none";
  const cls = `${base} ${className ?? ""}`.trim();

  if (peek.isLoading) {
    return (
      <span
        className={`${cls} border-zinc-300 bg-zinc-100 text-zinc-600`}
        title="Loading Genius Core context slot…"
      >
        <Loader2 className="h-3 w-3 animate-spin" />
        Genius Core
      </span>
    );
  }

  if (peek.isError) {
    return (
      <span
        className={`${cls} border-red-300 bg-red-50 text-red-700`}
        title={peek.error instanceof Error ? peek.error.message : "unknown error"}
      >
        <AlertCircle className="h-3 w-3" />
        Genius Core: error
      </span>
    );
  }

  const info = peek.data;
  if (!info || !info.cid) {
    return (
      <span
        className={`${cls} border-zinc-300 bg-zinc-50 text-zinc-500`}
        title="No personalised context slot for this project yet — train one via Genius Core settings."
      >
        <Sparkles className="h-3 w-3" />
        Genius Core: fresh
      </span>
    );
  }

  const tooltip = [
    `CID: ${info.cid}`,
    info.baseModelId ? `Base: ${info.baseModelId}` : null,
    info.adapterBytes ? `Adapter: ${formatBytes(info.adapterBytes)}` : null,
    info.previousCid ? `Prev: ${shortenCid(info.previousCid)}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  return (
    <button
      type="button"
      onClick={() => open.mutate(projectId)}
      disabled={open.isPending}
      className={`${cls} border-emerald-300 bg-emerald-50 text-emerald-800 hover:bg-emerald-100 disabled:opacity-60`}
      title={tooltip}
    >
      {open.isPending ? (
        <Loader2 className="h-3 w-3 animate-spin" />
      ) : (
        <Sparkles className="h-3 w-3" />
      )}
      Genius Core: {shortenCid(info.cid)}
    </button>
  );
}
