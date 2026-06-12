/**
 * Preview engine — frame-accurate multi-track compositor for the video editor.
 *
 * Two layers:
 *  1. A PURE resolver (`resolveFrameLayers`) that, given a {@link VideoTimelineV2}
 *     and a playhead time, returns the ordered list of layers to draw with
 *     computed opacity (handling crossfade transitions + overlay fades). This is
 *     framework-agnostic and unit-tested.
 *  2. A `PreviewEngine` class that realizes that plan on a canvas: it keeps a
 *     pool of `HTMLVideoElement`s (one per source), seeks them frame-accurately
 *     using `requestVideoFrameCallback` when available, and composites the
 *     visible layers (stacked video tracks + overlay PNGs) onto a 2D canvas.
 *
 * WebCodecs note: true `VideoDecoder`-based decode needs an MP4 demuxer to feed
 * encoded chunks, which is not yet a project dependency. The engine
 * feature-detects WebCodecs (`hasWebCodecs`) so a decoder-backed source can be
 * dropped in later without changing callers; until then it uses the
 * HTMLVideoElement path, which is frame-accurate enough for editor preview.
 */

import {
  videoClipDuration,
  videoClipEnd,
  type VideoClipV2,
  type VideoTimelineV2,
  type VideoTrackV2,
} from "./timeline_v2";

// ── Pure frame resolver ────────────────────────────────────────────────────────

export interface VideoFrameLayer {
  kind: "video";
  trackId: string;
  clipId: string;
  videoId?: number;
  filePath?: string;
  /** Source-file time to display (seconds), speed-adjusted. */
  sourceTime: number;
  /** 0..1 — drives crossfades. */
  opacity: number;
  /** Lower draws on top (earlier video tracks stack above later ones). */
  z: number;
}

export interface OverlayFrameLayer {
  kind: "overlay";
  trackId: string;
  itemId: string;
  pngBase64: string;
  opacity: number;
  z: number;
}

export type FrameLayer = VideoFrameLayer | OverlayFrameLayer;

const EPS = 1e-6;

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/** Source-file time for a video clip at timeline `time` (speed-adjusted). */
export function clipSourceTime(clip: VideoClipV2, time: number): number {
  const speed = clip.speed && clip.speed > 0 ? clip.speed : 1;
  return clip.trimStart + (time - clip.timelineStart) * speed;
}

/**
 * Opacity of a video clip at `time`, accounting for a crossfade INTO this clip
 * (from the previous clip's `transitionToNext`) and a crossfade OUT of it
 * (its own `transitionToNext`).
 */
function videoClipOpacity(
  clip: VideoClipV2,
  prev: VideoClipV2 | undefined,
  time: number,
): number {
  let op = 1;
  if (prev?.transitionToNext) {
    const d = prev.transitionToNext.duration;
    if (d > 0 && time < clip.timelineStart + d) {
      op = Math.min(op, (time - clip.timelineStart) / d);
    }
  }
  if (clip.transitionToNext) {
    const d = clip.transitionToNext.duration;
    const end = videoClipEnd(clip);
    if (d > 0 && time > end - d) {
      op = Math.min(op, (end - time) / d);
    }
  }
  return clamp01(op);
}

/** Opacity of an overlay item at `time` given its fade in/out. */
function overlayOpacity(
  item: { start: number; end: number; fadeIn?: number; fadeOut?: number },
  time: number,
): number {
  let op = 1;
  if (item.fadeIn && item.fadeIn > 0 && time < item.start + item.fadeIn) {
    op = Math.min(op, (time - item.start) / item.fadeIn);
  }
  if (item.fadeOut && item.fadeOut > 0 && time > item.end - item.fadeOut) {
    op = Math.min(op, (item.end - time) / item.fadeOut);
  }
  return clamp01(op);
}

/**
 * Resolve the ordered set of layers visible at `time`. Result is sorted by `z`
 * ascending so the caller draws bottom-up (highest z first); overlays always
 * composite above all video.
 */
export function resolveFrameLayers(
  timeline: VideoTimelineV2,
  time: number,
): FrameLayer[] {
  const videoLayers: VideoFrameLayer[] = [];
  const overlayLayers: OverlayFrameLayer[] = [];

  timeline.tracks.forEach((track, trackIdx) => {
    if (track.muted) return;

    if (track.kind === "video") {
      const vt = track as VideoTrackV2;
      vt.clips.forEach((clip, i) => {
        const start = clip.timelineStart;
        const end = videoClipEnd(clip);
        if (time < start - EPS || time >= end + EPS) return;
        if (videoClipDuration(clip) <= 0) return;
        const opacity = videoClipOpacity(clip, vt.clips[i - 1], time);
        if (opacity <= 0) return;
        videoLayers.push({
          kind: "video",
          trackId: track.id,
          clipId: clip.id,
          videoId: clip.videoId,
          sourceTime: clipSourceTime(clip, time),
          opacity,
          z: trackIdx,
        });
      });
    } else if (track.kind === "overlay") {
      for (const item of track.items) {
        if (time < item.start - EPS || time > item.end + EPS) continue;
        const opacity = overlayOpacity(item, time);
        if (opacity <= 0) continue;
        overlayLayers.push({
          kind: "overlay",
          trackId: track.id,
          itemId: item.id,
          pngBase64: item.pngBase64,
          opacity,
          // Overlays always above video; preserve track order among overlays.
          z: -1000 - trackIdx,
        });
      }
    }
    // Audio tracks contribute no visible layer.
  });

  // Sort by z ascending; caller draws from highest z (back) to lowest (front).
  return [...videoLayers, ...overlayLayers].sort((a, b) => b.z - a.z);
}

// ── Canvas compositor ──────────────────────────────────────────────────────────

/** Resolve a source identifier to a playable object URL (e.g. via IpcClient). */
export type SourceResolver = (layer: VideoFrameLayer) => Promise<string>;

/** True when the WebCodecs API is available (future decoder-backed path). */
export function hasWebCodecs(): boolean {
  return (
    typeof globalThis !== "undefined" &&
    typeof (globalThis as { VideoDecoder?: unknown }).VideoDecoder === "function"
  );
}

interface PooledVideo {
  el: HTMLVideoElement;
  url: string;
  ready: boolean;
}

export interface PreviewEngineOptions {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
  resolveSource: SourceResolver;
  /** Background fill (letterboxing). Defaults to black. */
  backgroundColor?: string;
}

/**
 * Composites a {@link VideoTimelineV2} onto a canvas at a given playhead time.
 * Call `seek(time)` to render a single frame (scrubbing); call `dispose()` when
 * unmounting to release video elements and object URLs.
 */
export class PreviewEngine {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly pool = new Map<string, PooledVideo>();
  private readonly overlayCache = new Map<string, HTMLImageElement>();
  private disposed = false;

  constructor(private readonly opts: PreviewEngineOptions) {
    const ctx = opts.canvas.getContext("2d");
    if (!ctx) throw new Error("PreviewEngine: 2D canvas context unavailable");
    this.ctx = ctx;
    opts.canvas.width = opts.width;
    opts.canvas.height = opts.height;
  }

  /** Key a pooled element by source (videoId or filePath). */
  private sourceKey(layer: VideoFrameLayer): string {
    return layer.videoId != null ? `v:${layer.videoId}` : `f:${layer.filePath ?? ""}`;
  }

  private async getVideoEl(layer: VideoFrameLayer): Promise<HTMLVideoElement> {
    const key = this.sourceKey(layer);
    const existing = this.pool.get(key);
    if (existing) return existing.el;

    const url = await this.opts.resolveSource(layer);
    const el = document.createElement("video");
    el.muted = true;
    el.playsInline = true;
    el.preload = "auto";
    el.src = url;
    const pooled: PooledVideo = { el, url, ready: false };
    this.pool.set(key, pooled);
    await new Promise<void>((resolve) => {
      const done = () => {
        pooled.ready = true;
        resolve();
      };
      if (el.readyState >= 1) done();
      else {
        el.addEventListener("loadedmetadata", done, { once: true });
        el.addEventListener("error", () => resolve(), { once: true });
      }
    });
    return el;
  }

  /** Seek a video element to `t` and resolve once that frame is presented. */
  private seekVideo(el: HTMLVideoElement, t: number): Promise<void> {
    const target = Math.max(0, Number.isFinite(el.duration) ? Math.min(t, el.duration) : t);
    if (Math.abs(el.currentTime - target) < 0.02) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const rvfc = (el as HTMLVideoElement & {
        requestVideoFrameCallback?: (cb: () => void) => number;
      }).requestVideoFrameCallback;
      el.addEventListener("seeked", finish, { once: true });
      if (typeof rvfc === "function") rvfc.call(el, finish);
      el.currentTime = target;
      // Safety net if neither event fires (e.g. identical frame).
      setTimeout(finish, 200);
    });
  }

  private async getOverlayImage(layer: OverlayFrameLayer): Promise<HTMLImageElement | null> {
    if (!layer.pngBase64) return null;
    const cached = this.overlayCache.get(layer.itemId);
    if (cached) return cached;
    const img = new Image();
    img.src = layer.pngBase64.startsWith("data:")
      ? layer.pngBase64
      : `data:image/png;base64,${layer.pngBase64}`;
    await new Promise<void>((resolve) => {
      if (img.complete) resolve();
      else {
        img.addEventListener("load", () => resolve(), { once: true });
        img.addEventListener("error", () => resolve(), { once: true });
      }
    });
    this.overlayCache.set(layer.itemId, img);
    return img;
  }

  /** Render the single frame at timeline time `t`. */
  async seek(timeline: VideoTimelineV2, t: number): Promise<void> {
    if (this.disposed) return;
    const layers = resolveFrameLayers(timeline, t);
    const { ctx, opts } = this;

    ctx.clearRect(0, 0, opts.width, opts.height);
    ctx.fillStyle = opts.backgroundColor ?? "#000000";
    ctx.fillRect(0, 0, opts.width, opts.height);

    // Prepare every video element/seek in parallel, then draw in z-order.
    await Promise.all(
      layers
        .filter((l): l is VideoFrameLayer => l.kind === "video")
        .map(async (layer) => {
          const el = await this.getVideoEl(layer);
          await this.seekVideo(el, layer.sourceTime);
        }),
    );
    if (this.disposed) return;

    // layers are sorted back-to-front already.
    for (const layer of layers) {
      ctx.save();
      ctx.globalAlpha = layer.opacity;
      if (layer.kind === "video") {
        const pooled = this.pool.get(this.sourceKey(layer));
        if (pooled?.ready) {
          this.drawContain(pooled.el, pooled.el.videoWidth, pooled.el.videoHeight);
        }
      } else {
        const img = await this.getOverlayImage(layer);
        if (img && img.naturalWidth > 0) {
          ctx.drawImage(img, 0, 0, opts.width, opts.height);
        }
      }
      ctx.restore();
    }
  }

  /** Draw a source preserving aspect ratio, letterboxed into the canvas. */
  private drawContain(
    src: CanvasImageSource,
    srcW: number,
    srcH: number,
  ): void {
    const { ctx, opts } = this;
    if (!srcW || !srcH) {
      ctx.drawImage(src, 0, 0, opts.width, opts.height);
      return;
    }
    const scale = Math.min(opts.width / srcW, opts.height / srcH);
    const w = srcW * scale;
    const h = srcH * scale;
    ctx.drawImage(src, (opts.width - w) / 2, (opts.height - h) / 2, w, h);
  }

  dispose(): void {
    this.disposed = true;
    for (const pooled of this.pool.values()) {
      try {
        pooled.el.pause();
        pooled.el.removeAttribute("src");
        pooled.el.load();
        URL.revokeObjectURL(pooled.url);
      } catch {
        /* ignore */
      }
    }
    this.pool.clear();
    this.overlayCache.clear();
  }
}
