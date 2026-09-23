/**
 * Timeline lane primitives for the video editor.
 *
 * Extracted from the monolithic VideoEditor so the multi-track timeline is
 * built from small, reusable, individually-styled pieces:
 *  - {@link TrackLane}        — a labeled horizontal lane (icon + name gutter).
 *  - {@link TimelineRuler}    — second tick marks + click-to-seek.
 *  - {@link TimelinePlayhead} — the vertical playhead indicator.
 *  - {@link TimelineClipBlock}— a positioned clip rectangle (time → pixels via
 *                               `pps`), used by every kind of track.
 *
 * These are presentational and framework-light: positioning is derived purely
 * from `start`/`duration` seconds and a `pps` (pixels-per-second) zoom, matching
 * the positioned-clip geometry of the Timeline v2 model.
 */

import type React from "react";

/** A labeled timeline lane with a sticky left gutter. */
export function TrackLane({
  icon,
  label,
  children,
  accent,
}: {
  icon: React.ReactNode;
  label: string;
  children: React.ReactNode;
  /** Optional tailwind text color class for the gutter label. */
  accent?: string;
}) {
  return (
    <div className="relative h-12 border-b">
      <div
        className={`absolute left-0 top-0 bottom-0 z-10 w-16 bg-background/90 border-r flex items-center gap-1 px-2 text-[10px] ${
          accent ?? "text-muted-foreground"
        }`}
      >
        {icon}
        {label}
      </div>
      <div className="absolute left-16 right-0 top-0 bottom-0">{children}</div>
    </div>
  );
}

/** Ruler with 1-second ticks; clicking seeks the playhead. */
export function TimelineRuler({
  duration,
  pps,
  onSeek,
}: {
  duration: number;
  pps: number;
  onSeek: (time: number) => void;
}) {
  return (
    <div
      className="h-5 border-b relative cursor-pointer"
      onClick={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        const t = (e.clientX - rect.left) / pps;
        onSeek(Math.max(0, Math.min(duration, t)));
      }}
    >
      {Array.from({ length: Math.ceil(duration) + 1 }).map((_, i) => (
        <div
          key={i}
          className="absolute top-0 h-full border-l border-border/50 text-[8px] text-muted-foreground pl-0.5"
          style={{ left: i * pps }}
        >
          {i}s
        </div>
      ))}
    </div>
  );
}

/** Vertical playhead line + handle. */
export function TimelinePlayhead({
  time,
  pps,
}: {
  time: number;
  pps: number;
}) {
  return (
    <div
      className="absolute top-0 bottom-0 w-px bg-violet-500 z-20 pointer-events-none"
      style={{ left: time * pps }}
    >
      <div className="w-2 h-2 -ml-1 rounded-full bg-violet-500" />
    </div>
  );
}

/**
 * A positioned clip rectangle. Placement is `start * pps` with width
 * `duration * pps`. Visual state is driven by `selected`; an optional trailing
 * `transitionBadge` marks a crossfade into the next clip.
 */
export function TimelineClipBlock({
  start,
  duration,
  pps,
  selected,
  onSelect,
  toneClass,
  children,
  transitionBadge,
  minWidthPx = 20,
}: {
  start: number;
  duration: number;
  pps: number;
  selected: boolean;
  onSelect: () => void;
  /** Unselected background/border tailwind classes (e.g. "bg-muted ..."). */
  toneClass: string;
  children: React.ReactNode;
  transitionBadge?: boolean;
  minWidthPx?: number;
}) {
  return (
    <div
      className={`absolute top-1 bottom-1 rounded border-2 overflow-hidden cursor-pointer flex items-center px-1 text-[10px] ${
        selected ? "border-violet-500 bg-violet-500/20" : toneClass
      }`}
      style={{
        left: start * pps + 1,
        width: Math.max(minWidthPx, duration * pps - 2),
      }}
      onClick={onSelect}
    >
      {children}
      {transitionBadge && (
        <span className="absolute right-0 top-0 bottom-0 w-2 bg-gradient-to-l from-violet-500/60" />
      )}
    </div>
  );
}
