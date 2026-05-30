/**
 * FFmpeg-backed video render engine for the JoyCreate video editor.
 *
 * Uses the bundled `ffmpeg-static` binary (falling back to a system `ffmpeg`
 * on PATH) via `spawn`. Rendering is staged into discrete passes for
 * robustness:
 *
 *   1. Normalize each clip → scaled/padded/fps-locked segment with a guaranteed
 *      audio stream (silent if the source has none).
 *   2. Concatenate segments — lossless concat demuxer when there are no
 *      transitions, otherwise xfade/acrossfade chaining.
 *   3. Composite timed overlay PNGs (full-canvas RGBA, pre-rasterized by the
 *      renderer) with optional alpha fades.
 *   4. Mix extra audio tracks (music / voiceover) over the clip audio.
 *
 * Overlays are rasterized client-side (Konva/canvas) so we never depend on
 * libfreetype/fontconfig being present in the ffmpeg build.
 */

import { app } from "electron";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import log from "electron-log";

import type { VideoTimeline, TransitionType } from "./timeline_types";

const logger = log.scope("video_ffmpeg");

// ── Binary resolution ────────────────────────────────────────────────────────

let cachedFfmpegBin: string | null = null;

export function getFfmpegBin(): string {
  if (cachedFfmpegBin) return cachedFfmpegBin;
  try {
    // ffmpeg-static is an optional dependency; load lazily so a failed install
    // never crashes the main bundle.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("ffmpeg-static");
    let bin: string | null = null;
    if (typeof mod === "string") bin = mod;
    else if (mod && typeof mod === "object" && "default" in mod) {
      const p = (mod as { default?: unknown }).default;
      if (typeof p === "string") bin = p;
    }
    if (bin) {
      // In packaged builds the binary lives under app.asar.unpacked.
      const unpacked = bin.replace("app.asar", "app.asar.unpacked");
      if (fs.existsSync(unpacked)) {
        cachedFfmpegBin = unpacked;
        return cachedFfmpegBin;
      }
      if (fs.existsSync(bin)) {
        cachedFfmpegBin = bin;
        return cachedFfmpegBin;
      }
    }
  } catch {
    /* not installed — fall through */
  }
  cachedFfmpegBin = "ffmpeg";
  return cachedFfmpegBin;
}

// ── Low-level spawn helper ─────────────────────────────────────────────────────

export interface RunOptions {
  /** Called with stderr text chunks (ffmpeg writes progress to stderr). */
  onStderr?: (chunk: string) => void;
}

function runFfmpeg(args: string[], opts: RunOptions = {}): Promise<void> {
  const bin = getFfmpegBin();
  return new Promise<void>((resolve, reject) => {
    logger.info(`ffmpeg ${args.join(" ")}`);
    const proc = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderrTail = "";
    proc.stderr?.on("data", (d: Buffer) => {
      const text = d.toString();
      stderrTail = (stderrTail + text).slice(-4000);
      opts.onStderr?.(text);
    });
    proc.on("error", reject);
    proc.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(
            new Error(
              `ffmpeg exited with code ${code}.\n${stderrTail.slice(-1500)}`,
            ),
          ),
    );
  });
}

// ── Probe ──────────────────────────────────────────────────────────────────────

export interface ProbeResult {
  duration: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  hasAudio: boolean;
}

/**
 * Probe a media file by parsing `ffmpeg -i` stderr (ffprobe is not bundled).
 */
export function probeVideo(filePath: string): Promise<ProbeResult> {
  return new Promise<ProbeResult>((resolve) => {
    const bin = getFfmpegBin();
    const proc = spawn(bin, ["-i", filePath], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let buf = "";
    proc.stderr?.on("data", (d: Buffer) => {
      buf += d.toString();
    });
    proc.on("error", () =>
      resolve({ duration: null, width: null, height: null, fps: null, hasAudio: false }),
    );
    proc.on("exit", () => {
      const result: ProbeResult = {
        duration: null,
        width: null,
        height: null,
        fps: null,
        hasAudio: /Stream #\d+:\d+.*: Audio:/.test(buf),
      };
      const durMatch = buf.match(/Duration:\s*(\d+):(\d+):(\d+\.?\d*)/);
      if (durMatch) {
        result.duration =
          Number(durMatch[1]) * 3600 +
          Number(durMatch[2]) * 60 +
          Number(durMatch[3]);
      }
      const resMatch = buf.match(/Video:.*?(\d{2,5})x(\d{2,5})/);
      if (resMatch) {
        result.width = Number(resMatch[1]);
        result.height = Number(resMatch[2]);
      }
      const fpsMatch = buf.match(/(\d+\.?\d*)\s*fps/);
      if (fpsMatch) result.fps = Number(fpsMatch[1]);
      resolve(result);
    });
  });
}

// ── Thumbnail ────────────────────────────────────────────────────────────────

export async function extractThumbnail(
  filePath: string,
  atSeconds: number,
  outPath: string,
): Promise<string> {
  await runFfmpeg([
    "-y",
    "-ss",
    String(Math.max(0, atSeconds)),
    "-i",
    filePath,
    "-frames:v",
    "1",
    "-q:v",
    "3",
    outPath,
  ]);
  return outPath;
}

// ── Render engine ──────────────────────────────────────────────────────────────

const XFADE_MAP: Record<TransitionType, string> = {
  fade: "fade",
  fadeblack: "fadeblack",
  fadewhite: "fadewhite",
  dissolve: "dissolve",
  wipeleft: "wipeleft",
  wiperight: "wiperight",
  slideleft: "slideleft",
  slideright: "slideright",
  circleopen: "circleopen",
};

function clipDuration(trimStart: number, trimEnd: number, speed: number): number {
  return Math.max(0.05, (trimEnd - trimStart) / (speed > 0 ? speed : 1));
}

function hexToFfmpegColor(hex: string | undefined): string {
  if (!hex) return "black";
  const h = hex.replace("#", "");
  if (h.length === 6) return `0x${h}`;
  return "black";
}

function ffPath(p: string): string {
  // Escape backslashes for ffmpeg arg list (we still pass as separate argv,
  // but concat list files need forward-friendly paths).
  return p.replace(/\\/g, "/");
}

export interface RenderTimelineInput {
  timeline: VideoTimeline;
  /** Resolve a clip/audio source DB video id to an absolute file path. */
  resolveVideoPath: (videoId: number) => string;
  /** Absolute output file path (.mp4). */
  outputPath: string;
  /** Progress callback (0..1) with a stage label. */
  onProgress?: (fraction: number, stage: string) => void;
}

export async function renderTimeline(input: RenderTimelineInput): Promise<void> {
  const { timeline, resolveVideoPath, outputPath, onProgress } = input;
  if (!timeline.clips.length) {
    throw new Error("Cannot render an empty timeline — add at least one clip.");
  }

  const { width, height, fps } = timeline;
  const bg = hexToFfmpegColor(timeline.backgroundColor);
  const tmpDir = path.join(
    app.getPath("userData"),
    "video-studio",
    `.render-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  fs.mkdirSync(tmpDir, { recursive: true });

  const cleanup = () => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  };

  try {
    // ── Stage 1: normalize each clip into a uniform segment ──────────────────
    const segmentPaths: string[] = [];
    const segmentDurations: number[] = [];

    for (let i = 0; i < timeline.clips.length; i++) {
      const clip = timeline.clips[i];
      const src = resolveVideoPath(clip.videoId);
      if (!fs.existsSync(src)) {
        throw new Error(`Source video missing for clip ${i + 1}: ${src}`);
      }
      const speed = clip.speed && clip.speed > 0 ? clip.speed : 1;
      const dur = clipDuration(clip.trimStart, clip.trimEnd, speed);
      const muted = timeline.muteClipAudio || (clip.volume ?? 1) <= 0;
      const probe = await probeVideo(src);
      const segPath = path.join(tmpDir, `seg_${i}.mp4`);

      const vChain =
        `scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
        `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:${bg},setsar=1,` +
        `fps=${fps},setpts=${(1 / speed).toFixed(4)}*PTS`;

      const args = ["-y", "-ss", String(clip.trimStart), "-to", String(clip.trimEnd), "-i", src];

      if (probe.hasAudio && !muted) {
        const vol = clip.volume ?? 1;
        // atempo supports 0.5..2.0 in one stage; UI clamps speed to that range.
        const aChain = `volume=${vol.toFixed(3)},atempo=${Math.min(2, Math.max(0.5, speed)).toFixed(3)},aresample=44100`;
        args.push(
          "-filter_complex",
          `[0:v]${vChain}[v];[0:a]${aChain}[a]`,
          "-map", "[v]", "-map", "[a]",
        );
      } else {
        // Synthesize a silent stereo track so every segment has audio.
        args.push(
          "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
          "-filter_complex", `[0:v]${vChain}[v]`,
          "-map", "[v]", "-map", "1:a", "-shortest",
        );
      }
      args.push(
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-ar", "44100", "-ac", "2",
        "-video_track_timescale", "90000",
        segPath,
      );

      await runFfmpeg(args, {
        onStderr: () => onProgress?.((i + 1) / (timeline.clips.length + 2) * 0.5, `Preparing clip ${i + 1}/${timeline.clips.length}`),
      });
      segmentPaths.push(segPath);
      segmentDurations.push(dur);
    }

    const hasTransitions = timeline.clips.some((c) => c.transitionToNext);

    // ── Stage 2: concatenate ─────────────────────────────────────────────────
    let concatPath = path.join(tmpDir, "concat.mp4");

    if (segmentPaths.length === 1) {
      concatPath = segmentPaths[0];
    } else if (!hasTransitions) {
      // Lossless concat demuxer (segments share codec/params).
      const listFile = path.join(tmpDir, "concat.txt");
      fs.writeFileSync(
        listFile,
        segmentPaths.map((p) => `file '${ffPath(p)}'`).join("\n"),
        "utf8",
      );
      onProgress?.(0.6, "Joining clips");
      await runFfmpeg([
        "-y", "-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", concatPath,
      ]);
    } else {
      // xfade / acrossfade chaining.
      const inputs: string[] = [];
      segmentPaths.forEach((p) => inputs.push("-i", p));

      const vParts: string[] = [];
      const aParts: string[] = [];
      let vLabel = "0:v";
      let aLabel = "0:a";
      let cumulative = segmentDurations[0];

      for (let i = 1; i < segmentPaths.length; i++) {
        const prev = timeline.clips[i - 1];
        const trans = prev.transitionToNext;
        const tDur = trans ? Math.min(trans.duration, segmentDurations[i - 1], segmentDurations[i]) : 0;
        const outV = `vx${i}`;
        const outA = `ax${i}`;
        if (trans && tDur > 0.01) {
          const offset = Math.max(0, cumulative - tDur);
          vParts.push(
            `[${vLabel}][${i}:v]xfade=transition=${XFADE_MAP[trans.type] ?? "fade"}:duration=${tDur.toFixed(3)}:offset=${offset.toFixed(3)}[${outV}]`,
          );
          aParts.push(
            `[${aLabel}][${i}:a]acrossfade=d=${tDur.toFixed(3)}:c1=tri:c2=tri[${outA}]`,
          );
          cumulative = cumulative + segmentDurations[i] - tDur;
        } else {
          // No transition between these two — hard concat via xfade duration 0
          // is invalid, so fall back to concat filter for this pair.
          vParts.push(`[${vLabel}][${i}:v]concat=n=2:v=1:a=0[${outV}]`);
          aParts.push(`[${aLabel}][${i}:a]concat=n=2:v=0:a=1[${outA}]`);
          cumulative += segmentDurations[i];
        }
        vLabel = outV;
        aLabel = outA;
      }

      const filterComplex = [...vParts, ...aParts].join(";");
      await runFfmpeg([
        "-y",
        ...inputs,
        "-filter_complex", filterComplex,
        "-map", `[${vLabel}]`, "-map", `[${aLabel}]`,
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-ar", "44100", "-ac", "2",
        concatPath,
      ], {
        onStderr: () => onProgress?.(0.6, "Joining clips & transitions"),
      });
    }

    // ── Stage 3: composite overlays ──────────────────────────────────────────
    let overlaidPath = concatPath;
    if (timeline.overlays.length > 0) {
      overlaidPath = path.join(tmpDir, "overlaid.mp4");
      const inputs: string[] = ["-i", concatPath];
      const overlayPngPaths: string[] = [];
      timeline.overlays.forEach((ov, idx) => {
        const pngPath = path.join(tmpDir, `ov_${idx}.png`);
        fs.writeFileSync(pngPath, Buffer.from(ov.pngBase64.replace(/^data:image\/\w+;base64,/, ""), "base64"));
        overlayPngPaths.push(pngPath);
        inputs.push("-i", pngPath);
      });

      const parts: string[] = [];
      let base = "0:v";
      timeline.overlays.forEach((ov, idx) => {
        const inIdx = idx + 1;
        const fadeIn = ov.fadeIn ?? 0;
        const fadeOut = ov.fadeOut ?? 0;
        const prepped = `ovp${idx}`;
        let prep = `[${inIdx}:v]format=rgba`;
        if (fadeIn > 0) prep += `,fade=t=in:st=${ov.start.toFixed(3)}:d=${fadeIn.toFixed(3)}:alpha=1`;
        if (fadeOut > 0) prep += `,fade=t=out:st=${(ov.end - fadeOut).toFixed(3)}:d=${fadeOut.toFixed(3)}:alpha=1`;
        prep += `[${prepped}]`;
        parts.push(prep);
        const outLabel = idx === timeline.overlays.length - 1 ? "vout" : `vmid${idx}`;
        parts.push(
          `[${base}][${prepped}]overlay=0:0:enable='between(t,${ov.start.toFixed(3)},${ov.end.toFixed(3)})'[${outLabel}]`,
        );
        base = outLabel;
      });

      await runFfmpeg([
        "-y",
        ...inputs,
        "-filter_complex", parts.join(";"),
        "-map", "[vout]", "-map", "0:a?",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
        "-c:a", "copy",
        overlaidPath,
      ], {
        onStderr: () => onProgress?.(0.8, "Compositing overlays"),
      });
    }

    // ── Stage 4: mix extra audio tracks ──────────────────────────────────────
    if (timeline.audioTracks.length > 0) {
      const inputs: string[] = ["-i", overlaidPath];
      const audioParts: string[] = [];
      const mixLabels: string[] = ["0:a"];

      timeline.audioTracks.forEach((track, idx) => {
        const src = track.filePath ?? (track.videoId != null ? resolveVideoPath(track.videoId) : null);
        if (!src || !fs.existsSync(src)) return;
        const inIdx = idx + 1;
        inputs.push("-ss", String(track.trimStart), "-to", String(track.trimEnd), "-i", src);
        const delayMs = Math.round(Math.max(0, track.start) * 1000);
        const label = `ta${idx}`;
        audioParts.push(
          `[${inIdx}:a]volume=${track.volume.toFixed(3)},aresample=44100,adelay=${delayMs}|${delayMs}[${label}]`,
        );
        mixLabels.push(label);
      });

      if (mixLabels.length > 1) {
        const finalPath = path.join(tmpDir, "final.mp4");
        const filter =
          audioParts.join(";") +
          (audioParts.length ? ";" : "") +
          `[${mixLabels.join("][")}]amix=inputs=${mixLabels.length}:duration=longest:dropout_transition=0:normalize=0[aout]`;
        await runFfmpeg([
          "-y",
          ...inputs,
          "-filter_complex", filter,
          "-map", "0:v", "-map", "[aout]",
          "-c:v", "copy", "-c:a", "aac", "-ar", "44100", "-ac", "2",
          finalPath,
        ], {
          onStderr: () => onProgress?.(0.92, "Mixing audio"),
        });
        overlaidPath = finalPath;
      }
    }

    // ── Finalize: move to output ─────────────────────────────────────────────
    fs.copyFileSync(overlaidPath, outputPath);
    onProgress?.(1, "Done");
  } finally {
    cleanup();
  }
}
