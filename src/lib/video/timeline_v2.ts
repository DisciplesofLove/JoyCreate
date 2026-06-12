/**
 * Timeline v2 — multi-track video editor model.
 *
 * Phase 1 of the AI Video Suite upgrade. Replaces the single sequential clip
 * lane of {@link VideoTimeline} (v1) with positioned clips on N tracks
 * (video / audio / overlay), plus markers and per-track mute/solo/lock.
 *
 * Design rules:
 *  - Pure data + pure functions only (no Electron / DOM imports) so this module
 *    is shared verbatim by the renderer UI, the main-process render pipeline,
 *    and Vitest.
 *  - All edit operations are immutable: they return a NEW timeline and never
 *    mutate their input (undo/redo = stack of timeline snapshots).
 *  - `migrateTimeline()` accepts any persisted `videoProjects.timelineJson`
 *    (v1 or v2) and returns v2 — stored projects upgrade lazily on load.
 *  - `toLegacyTimeline()` bridges back to v1 so the existing ffmpeg
 *    `renderTimeline()` keeps working until native multi-track render lands.
 */

import type {
  TransitionType,
  TimelineOverlay,
  VideoTimeline,
} from "./timeline_types";

// ── Types ────────────────────────────────────────────────────────────────────

export type TrackKind = "video" | "audio" | "overlay";

/** A positioned clip on a video track. */
export interface VideoClipV2 {
  id: string;
  /** DB id of the source video in `video_studio_videos`. */
  videoId: number;
  /** Where the clip starts on the timeline (seconds). */
  timelineStart: number;
  /** Trim window into the source file (seconds). */
  trimStart: number;
  trimEnd: number;
  /** Playback speed multiplier (1 = normal). */
  speed?: number;
  /** Per-clip volume multiplier (0 = mute, 1 = normal). */
  volume?: number;
  label?: string;
  /**
   * Transition into the NEXT adjacent clip on the same track. Only rendered
   * when the next clip starts exactly where this one ends (butted clips).
   */
  transitionToNext?: { type: TransitionType; duration: number };
}

/** A positioned clip on an audio track (music / voiceover / extracted audio). */
export interface AudioClipV2 {
  id: string;
  /** DB id of a video whose audio is used, OR an absolute audio file path. */
  videoId?: number;
  filePath?: string;
  timelineStart: number;
  trimStart: number;
  trimEnd: number;
  /** Volume multiplier (0..2). */
  volume: number;
  label?: string;
}

/** An item on an overlay track (pre-rasterized PNG — same payload as v1). */
export type OverlayItemV2 = TimelineOverlay;

interface TrackBase {
  id: string;
  name?: string;
  muted?: boolean;
  solo?: boolean;
  locked?: boolean;
}

export interface VideoTrackV2 extends TrackBase {
  kind: "video";
  clips: VideoClipV2[];
  /** Mute the audio that ships inside this track's video clips. */
  muteClipAudio?: boolean;
}

export interface AudioTrackV2 extends TrackBase {
  kind: "audio";
  clips: AudioClipV2[];
}

export interface OverlayTrackV2 extends TrackBase {
  kind: "overlay";
  items: OverlayItemV2[];
}

export type TimelineTrackV2 = VideoTrackV2 | AudioTrackV2 | OverlayTrackV2;

export interface TimelineMarker {
  id: string;
  time: number;
  label?: string;
  /** e.g. a storyboard scene boundary. */
  kind?: "generic" | "scene" | "chapter";
}

export interface VideoTimelineV2 {
  version: 2;
  width: number;
  height: number;
  fps: number;
  /** Background color used for letterboxing/padding (hex). */
  backgroundColor?: string;
  /**
   * Ordered top-to-bottom for video stacking: earlier video tracks render ON
   * TOP of later ones. Audio tracks all mix; overlay tracks composite above
   * all video.
   */
  tracks: TimelineTrackV2[];
  markers?: TimelineMarker[];
}

// ── Construction ─────────────────────────────────────────────────────────────

let idCounter = 0;
function generateId(prefix: string): string {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${idCounter}`;
}

export function createEmptyTimelineV2(
  width = 1280,
  height = 720,
  fps = 30,
): VideoTimelineV2 {
  return {
    version: 2,
    width,
    height,
    fps,
    backgroundColor: "#000000",
    tracks: [
      { id: generateId("track_v"), kind: "video", name: "Video 1", clips: [] },
      { id: generateId("track_a"), kind: "audio", name: "Audio 1", clips: [] },
      { id: generateId("track_o"), kind: "overlay", name: "Text & Overlays", items: [] },
    ],
    markers: [],
  };
}

// ── Durations ────────────────────────────────────────────────────────────────

/** Played duration of a video clip in timeline seconds (trim window / speed). */
export function videoClipDuration(clip: VideoClipV2): number {
  const speed = clip.speed && clip.speed > 0 ? clip.speed : 1;
  return Math.max(0, (clip.trimEnd - clip.trimStart) / speed);
}

export function audioClipDuration(clip: AudioClipV2): number {
  return Math.max(0, clip.trimEnd - clip.trimStart);
}

export function videoClipEnd(clip: VideoClipV2): number {
  return clip.timelineStart + videoClipDuration(clip);
}

export function audioClipEnd(clip: AudioClipV2): number {
  return clip.timelineStart + audioClipDuration(clip);
}

export function trackEnd(track: TimelineTrackV2): number {
  if (track.kind === "overlay") {
    return track.items.reduce((max, o) => Math.max(max, o.end), 0);
  }
  if (track.kind === "video") {
    return track.clips.reduce(
      (max, c) => Math.max(max, c.timelineStart + videoClipDuration(c)),
      0,
    );
  }
  return track.clips.reduce(
    (max, c) => Math.max(max, c.timelineStart + audioClipDuration(c)),
    0,
  );
}

/** Total timeline duration = latest end across all tracks. */
export function timelineDurationV2(timeline: VideoTimelineV2): number {
  return timeline.tracks.reduce((max, t) => Math.max(max, trackEnd(t)), 0);
}

// ── Migration (v1 → v2) ──────────────────────────────────────────────────────

function isV2(value: unknown): value is VideoTimelineV2 {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { version?: unknown }).version === 2 &&
    Array.isArray((value as { tracks?: unknown }).tracks)
  );
}

function isV1(value: unknown): value is VideoTimeline {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { version?: unknown }).version === undefined &&
    Array.isArray((value as { clips?: unknown }).clips)
  );
}

/**
 * Accept any persisted timeline JSON (v1 or v2) and return v2.
 * Throws on unrecognized shapes (corrupt project data).
 */
export function migrateTimeline(raw: unknown): VideoTimelineV2 {
  if (isV2(raw)) return raw;
  if (!isV1(raw)) {
    throw new Error("Unrecognized timeline format — cannot migrate");
  }
  const v1 = raw;

  // v1 clips are strictly sequential; compute positioned starts, honoring the
  // same xfade-overlap math as v1 `timelineDuration`.
  const videoClips: VideoClipV2[] = [];
  let cursor = 0;
  v1.clips.forEach((clip, idx) => {
    const speed = clip.speed && clip.speed > 0 ? clip.speed : 1;
    const dur = Math.max(0, (clip.trimEnd - clip.trimStart) / speed);
    const prev = v1.clips[idx - 1];
    if (prev?.transitionToNext) {
      cursor -= Math.min(prev.transitionToNext.duration, dur);
    }
    videoClips.push({
      id: clip.id,
      videoId: clip.videoId,
      timelineStart: Math.max(0, cursor),
      trimStart: clip.trimStart,
      trimEnd: clip.trimEnd,
      speed: clip.speed,
      volume: clip.volume,
      transitionToNext: clip.transitionToNext,
    });
    cursor += dur;
  });

  const audioClips: AudioClipV2[] = (v1.audioTracks ?? []).map((t) => ({
    id: t.id,
    videoId: t.videoId,
    filePath: t.filePath,
    timelineStart: t.start,
    trimStart: t.trimStart,
    trimEnd: t.trimEnd,
    volume: t.volume,
    label: t.label,
  }));

  return {
    version: 2,
    width: v1.width,
    height: v1.height,
    fps: v1.fps,
    backgroundColor: v1.backgroundColor,
    tracks: [
      {
        id: generateId("track_v"),
        kind: "video",
        name: "Video 1",
        clips: videoClips,
        muteClipAudio: v1.muteClipAudio,
      },
      {
        id: generateId("track_a"),
        kind: "audio",
        name: "Audio 1",
        clips: audioClips,
      },
      {
        id: generateId("track_o"),
        kind: "overlay",
        name: "Text & Overlays",
        items: v1.overlays ?? [],
      },
    ],
    markers: [],
  };
}

// ── Legacy bridge (v2 → v1) ──────────────────────────────────────────────────

/**
 * Flatten a v2 timeline back to v1 for the existing ffmpeg `renderTimeline()`.
 *
 * Uses the FIRST video track as the main lane (clips sorted by position and
 * butted sequentially — any gaps collapse, matching v1's sequential model).
 * All audio tracks merge into v1 `audioTracks`; all overlay tracks merge into
 * v1 `overlays`. This bridge is removed once native multi-track render ships.
 */
export function toLegacyTimeline(timeline: VideoTimelineV2): VideoTimeline {
  const videoTrack = timeline.tracks.find(
    (t): t is VideoTrackV2 => t.kind === "video" && !t.muted,
  );
  const sortedClips = [...(videoTrack?.clips ?? [])].sort(
    (a, b) => a.timelineStart - b.timelineStart,
  );

  return {
    width: timeline.width,
    height: timeline.height,
    fps: timeline.fps,
    backgroundColor: timeline.backgroundColor,
    muteClipAudio: videoTrack?.muteClipAudio,
    clips: sortedClips.map((c) => ({
      id: c.id,
      videoId: c.videoId,
      trimStart: c.trimStart,
      trimEnd: c.trimEnd,
      speed: c.speed,
      volume: c.volume,
      transitionToNext: c.transitionToNext,
    })),
    audioTracks: timeline.tracks
      .filter((t): t is AudioTrackV2 => t.kind === "audio" && !t.muted)
      .flatMap((t) =>
        t.clips.map((c) => ({
          id: c.id,
          videoId: c.videoId,
          filePath: c.filePath,
          start: c.timelineStart,
          trimStart: c.trimStart,
          trimEnd: c.trimEnd,
          volume: c.volume,
          label: c.label,
        })),
      ),
    overlays: timeline.tracks
      .filter((t): t is OverlayTrackV2 => t.kind === "overlay" && !t.muted)
      .flatMap((t) => t.items),
  };
}

// ── Edit operations (immutable) ──────────────────────────────────────────────

function replaceTrack(
  timeline: VideoTimelineV2,
  trackId: string,
  replacer: (track: TimelineTrackV2) => TimelineTrackV2,
): VideoTimelineV2 {
  let found = false;
  const tracks = timeline.tracks.map((t) => {
    if (t.id !== trackId) return t;
    found = true;
    return replacer(t);
  });
  if (!found) throw new Error(`Track not found: ${trackId}`);
  return { ...timeline, tracks };
}

/**
 * Split the clip under `time` on `trackId` into two clips at that exact
 * timeline position. No-op (returns the same timeline) if `time` does not
 * fall strictly inside a clip.
 */
export function splitClipAt(
  timeline: VideoTimelineV2,
  trackId: string,
  time: number,
): VideoTimelineV2 {
  return replaceTrack(timeline, trackId, (track) => {
    if (track.kind === "overlay") return track;

    if (track.kind === "video") {
      const idx = track.clips.findIndex(
        (c) =>
          time > c.timelineStart + 1e-6 &&
          time < c.timelineStart + videoClipDuration(c) - 1e-6,
      );
      if (idx === -1) return track;
      const clip = track.clips[idx];
      const speed = clip.speed && clip.speed > 0 ? clip.speed : 1;
      // Convert timeline offset into source-time offset.
      const sourceSplit = clip.trimStart + (time - clip.timelineStart) * speed;
      const left: VideoClipV2 = {
        ...clip,
        trimEnd: sourceSplit,
        transitionToNext: undefined,
      };
      const right: VideoClipV2 = {
        ...clip,
        id: generateId("clip"),
        timelineStart: time,
        trimStart: sourceSplit,
      };
      const clips = [...track.clips];
      clips.splice(idx, 1, left, right);
      return { ...track, clips };
    }

    // audio track
    const idx = track.clips.findIndex(
      (c) =>
        time > c.timelineStart + 1e-6 &&
        time < c.timelineStart + audioClipDuration(c) - 1e-6,
    );
    if (idx === -1) return track;
    const clip = track.clips[idx];
    const sourceSplit = clip.trimStart + (time - clip.timelineStart);
    const left: AudioClipV2 = { ...clip, trimEnd: sourceSplit };
    const right: AudioClipV2 = {
      ...clip,
      id: generateId("aclip"),
      timelineStart: time,
      trimStart: sourceSplit,
    };
    const clips = [...track.clips];
    clips.splice(idx, 1, left, right);
    return { ...track, clips };
  });
}

/**
 * Delete a clip and shift every later clip on the SAME track left by the
 * removed duration (classic ripple delete). When `rippleAll` is true the
 * shift applies to every non-locked track (multi-track sync editing) and
 * overlay items + markers after the cut point shift too.
 */
export function rippleDeleteClip(
  timeline: VideoTimelineV2,
  trackId: string,
  clipId: string,
  options?: { rippleAll?: boolean },
): VideoTimelineV2 {
  // Locate the clip to learn the gap being closed.
  const track = timeline.tracks.find((t) => t.id === trackId);
  if (!track) throw new Error(`Track not found: ${trackId}`);
  if (track.kind === "overlay") {
    throw new Error("Ripple delete is not supported on overlay tracks");
  }
  const clip = track.clips.find((c) => c.id === clipId) as
    | VideoClipV2
    | AudioClipV2
    | undefined;
  if (!clip) throw new Error(`Clip not found: ${clipId}`);

  const removedDuration =
    track.kind === "video"
      ? videoClipDuration(clip as VideoClipV2)
      : audioClipDuration(clip as AudioClipV2);
  const cutPoint = clip.timelineStart;

  const shiftLeft = <C extends { timelineStart: number }>(c: C): C =>
    c.timelineStart >= cutPoint + removedDuration - 1e-6
      ? { ...c, timelineStart: Math.max(cutPoint, c.timelineStart - removedDuration) }
      : c;

  const tracks = timeline.tracks.map((t): TimelineTrackV2 => {
    const isTarget = t.id === trackId;
    const shouldRipple = isTarget || (options?.rippleAll && !t.locked);

    if (t.kind === "overlay") {
      if (!options?.rippleAll || t.locked) return t;
      return {
        ...t,
        items: t.items.map((o) =>
          o.start >= cutPoint + removedDuration - 1e-6
            ? { ...o, start: o.start - removedDuration, end: o.end - removedDuration }
            : o,
        ),
      };
    }

    let clips = isTarget ? t.clips.filter((c) => c.id !== clipId) : t.clips;
    if (shouldRipple) clips = clips.map(shiftLeft);
    return { ...t, clips } as TimelineTrackV2;
  });

  const markers = options?.rippleAll
    ? (timeline.markers ?? []).map((m) =>
        m.time >= cutPoint + removedDuration - 1e-6
          ? { ...m, time: m.time - removedDuration }
          : m,
      )
    : timeline.markers;

  return { ...timeline, tracks, markers };
}

/** Delete a clip leaving a gap (non-ripple). */
export function deleteClip(
  timeline: VideoTimelineV2,
  trackId: string,
  clipId: string,
): VideoTimelineV2 {
  return replaceTrack(timeline, trackId, (track) => {
    if (track.kind === "overlay") {
      return { ...track, items: track.items.filter((o) => o.id !== clipId) };
    }
    return {
      ...track,
      clips: track.clips.filter((c) => c.id !== clipId),
    } as TimelineTrackV2;
  });
}

/**
 * Move a clip to a new start time, optionally onto another track of the SAME
 * kind. The new start is clamped to >= 0.
 */
export function moveClip(
  timeline: VideoTimelineV2,
  trackId: string,
  clipId: string,
  newStart: number,
  targetTrackId?: string,
): VideoTimelineV2 {
  const source = timeline.tracks.find((t) => t.id === trackId);
  if (!source) throw new Error(`Track not found: ${trackId}`);
  if (source.kind === "overlay") {
    // Overlay items move within their own track only.
    return replaceTrack(timeline, trackId, (track) => {
      const t = track as OverlayTrackV2;
      return {
        ...t,
        items: t.items.map((o) =>
          o.id === clipId
            ? { ...o, start: Math.max(0, newStart), end: Math.max(0, newStart) + (o.end - o.start) }
            : o,
        ),
      };
    });
  }

  const clip = source.clips.find((c) => c.id === clipId);
  if (!clip) throw new Error(`Clip not found: ${clipId}`);
  const destId = targetTrackId ?? trackId;
  const dest = timeline.tracks.find((t) => t.id === destId);
  if (!dest) throw new Error(`Track not found: ${destId}`);
  if (dest.kind !== source.kind) {
    throw new Error(`Cannot move a ${source.kind} clip onto a ${dest.kind} track`);
  }

  const moved = { ...clip, timelineStart: Math.max(0, newStart) };

  const tracks = timeline.tracks.map((t): TimelineTrackV2 => {
    if (t.kind === "overlay") return t;
    let clips = t.id === trackId ? t.clips.filter((c) => c.id !== clipId) : t.clips;
    if (t.id === destId) {
      clips = [...clips, moved] as typeof clips;
    }
    // Keep clips ordered by position for stable downstream math.
    clips = [...clips].sort((a, b) => a.timelineStart - b.timelineStart);
    return { ...t, clips } as TimelineTrackV2;
  });

  return { ...timeline, tracks };
}

// ── Snapping ─────────────────────────────────────────────────────────────────

/**
 * All candidate snap times: timeline start, clip edges on every track,
 * overlay edges, and markers. `excludeClipId` skips the clip being dragged.
 */
export function snapCandidates(
  timeline: VideoTimelineV2,
  excludeClipId?: string,
): number[] {
  const times = new Set<number>([0]);
  for (const track of timeline.tracks) {
    if (track.kind === "overlay") {
      for (const o of track.items) {
        if (o.id === excludeClipId) continue;
        times.add(o.start);
        times.add(o.end);
      }
      continue;
    }
    for (const c of track.clips) {
      if (c.id === excludeClipId) continue;
      times.add(c.timelineStart);
      times.add(
        c.timelineStart +
          (track.kind === "video"
            ? videoClipDuration(c as VideoClipV2)
            : audioClipDuration(c as AudioClipV2)),
      );
    }
  }
  for (const m of timeline.markers ?? []) times.add(m.time);
  return [...times].sort((a, b) => a - b);
}

/**
 * Snap `time` to the nearest candidate within `threshold` seconds.
 * Returns the snapped time and the candidate hit (or null when no snap).
 */
export function resolveSnap(
  time: number,
  candidates: number[],
  threshold: number,
): { time: number; snappedTo: number | null } {
  let best: number | null = null;
  let bestDist = threshold;
  for (const c of candidates) {
    const d = Math.abs(c - time);
    if (d <= bestDist) {
      bestDist = d;
      best = c;
    }
  }
  return best === null ? { time, snappedTo: null } : { time: best, snappedTo: best };
}

// ── Trimming ─────────────────────────────────────────────────────────────────

/** Smallest allowed played duration of a clip after a trim (seconds). */
const MIN_CLIP_DURATION = 0.05;

/**
 * Trim the in- ("start") or out- ("end") edge of a clip to a new TIMELINE time.
 *
 * - Trimming the "start" edge moves both `timelineStart` and `trimStart`
 *   (the clip stays anchored to its source frame).
 * - Trimming the "end" edge adjusts `trimEnd` only.
 *
 * Edges are speed-aware (timeline delta × speed = source delta) and clamped so
 * the played duration never drops below {@link MIN_CLIP_DURATION} and the trim
 * window never inverts (`trimStart >= 0`, `trimEnd > trimStart`).
 */
export function trimClip(
  timeline: VideoTimelineV2,
  trackId: string,
  clipId: string,
  edge: "start" | "end",
  newEdgeTime: number,
): VideoTimelineV2 {
  return replaceTrack(timeline, trackId, (track) => {
    if (track.kind === "overlay") return track;
    const idx = track.clips.findIndex((c) => c.id === clipId);
    if (idx === -1) return track;
    const clip = track.clips[idx];
    const speed =
      track.kind === "video" && clip.speed && clip.speed > 0 ? clip.speed : 1;
    const clips = [...track.clips];

    if (edge === "start") {
      const maxStart =
        clip.timelineStart +
        (track.kind === "video"
          ? videoClipDuration(clip as VideoClipV2)
          : audioClipDuration(clip as AudioClipV2)) -
        MIN_CLIP_DURATION;
      const newStart = Math.max(0, Math.min(newEdgeTime, maxStart));
      const sourceDelta = (newStart - clip.timelineStart) * speed;
      const newTrimStart = Math.max(0, clip.trimStart + sourceDelta);
      clips[idx] = {
        ...clip,
        timelineStart: newStart,
        trimStart: newTrimStart,
      } as typeof clip;
      return { ...track, clips } as TimelineTrackV2;
    }

    // edge === "end"
    const minEnd = clip.timelineStart + MIN_CLIP_DURATION;
    const newEnd = Math.max(minEnd, newEdgeTime);
    const playedDuration = newEnd - clip.timelineStart;
    const newTrimEnd = clip.trimStart + playedDuration * speed;
    clips[idx] = { ...clip, trimEnd: newTrimEnd } as typeof clip;
    return { ...track, clips } as TimelineTrackV2;
  });
}

// ── Track management ─────────────────────────────────────────────────────────

/** Append a new empty track of the given kind and return the new timeline. */
export function addTrack(
  timeline: VideoTimelineV2,
  kind: TrackKind,
  name?: string,
): VideoTimelineV2 {
  const base = { id: generateId(`track_${kind[0]}`), name } as const;
  const track: TimelineTrackV2 =
    kind === "overlay"
      ? { ...base, kind: "overlay", items: [] }
      : kind === "audio"
        ? { ...base, kind: "audio", clips: [] }
        : { ...base, kind: "video", clips: [] };
  return { ...timeline, tracks: [...timeline.tracks, track] };
}
