/**
 * Shared video-editor timeline model.
 *
 * Used by both the renderer (VideoEditor UI) and the main process
 * (ffmpeg render engine). Overlays are pre-rasterized to full-canvas RGBA PNGs
 * by the renderer (via Konva/canvas) so the main process only needs ffmpeg's
 * `overlay` filter with time gating â€” this avoids all font/drawtext portability
 * issues and gives Canva-quality text/shape styling.
 */

export type TransitionType =
  | "fade"
  | "fadeblack"
  | "fadewhite"
  | "dissolve"
  | "wipeleft"
  | "wiperight"
  | "slideleft"
  | "slideright"
  | "circleopen";

/** A single segment of the main video track. Clips play sequentially. */
export interface TimelineClip {
  id: string;
  /** DB id of the source video in `video_studio_videos`. */
  videoId: number;
  /** Trim window into the source file, in seconds. */
  trimStart: number;
  trimEnd: number;
  /** Playback speed multiplier (1 = normal, 2 = 2x faster, 0.5 = slow-mo). */
  speed?: number;
  /** Per-clip volume multiplier (0 = mute, 1 = normal). */
  volume?: number;
  /** Transition applied when crossing into the next clip. */
  transitionToNext?: {
    type: TransitionType;
    /** Transition duration in seconds. */
    duration: number;
  };
}

/**
 * A timed overlay. `pngBase64` is a full-canvas (width x height) RGBA PNG with
 * the element(s) already positioned/styled by the renderer. The main process
 * composites it with `overlay=enable='between(t,start,end)'`.
 */
export interface TimelineOverlay {
  id: string;
  /** Base64 (no data-URI prefix) full-canvas RGBA PNG. */
  pngBase64: string;
  /** Timeline start/end in seconds. */
  start: number;
  end: number;
  /** Fade in/out duration (seconds) applied to the overlay opacity. */
  fadeIn?: number;
  fadeOut?: number;
  /** Human label shown in the timeline track. */
  label?: string;
}

/** An extra audio track (music / voiceover) mixed over the clip audio. */
export interface TimelineAudioTrack {
  id: string;
  /** DB id of a video whose audio we extract, OR an absolute file path. */
  videoId?: number;
  filePath?: string;
  /** Where this audio starts on the timeline (seconds). */
  start: number;
  /** Trim window into the source audio (seconds). */
  trimStart: number;
  trimEnd: number;
  /** Volume multiplier (0..2). */
  volume: number;
  label?: string;
}

export interface VideoTimeline {
  width: number;
  height: number;
  fps: number;
  clips: TimelineClip[];
  overlays: TimelineOverlay[];
  audioTracks: TimelineAudioTrack[];
  /** Mute the audio that ships inside the video clips. */
  muteClipAudio?: boolean;
  /** Background color used for letterboxing/padding (hex, e.g. "#000000"). */
  backgroundColor?: string;
}

export function createEmptyTimeline(
  width = 1280,
  height = 720,
  fps = 30,
): VideoTimeline {
  return {
    width,
    height,
    fps,
    clips: [],
    overlays: [],
    audioTracks: [],
    muteClipAudio: false,
    backgroundColor: "#000000",
  };
}

/** Total timeline duration in seconds (sum of clip durations minus transition overlaps). */
export function timelineDuration(timeline: VideoTimeline): number {
  let total = 0;
  timeline.clips.forEach((clip, idx) => {
    const speed = clip.speed && clip.speed > 0 ? clip.speed : 1;
    const clipDur = Math.max(0, (clip.trimEnd - clip.trimStart) / speed);
    total += clipDur;
    // xfade overlaps the previous clip's tail with this clip's head.
    const prev = timeline.clips[idx - 1];
    if (prev?.transitionToNext) {
      total -= Math.min(prev.transitionToNext.duration, clipDur);
    }
  });
  return Math.max(0, total);
}
