/**
 * Podcast briefing packager.
 *
 * Stitches per-segment TTS clips together into a single MP3 / WAV briefing
 * suitable for morning-podcast or summary-of-the-day workflows.
 *
 * Strategy:
 *   1. Each input segment is a chunk of text + optional voice override.
 *   2. We delegate text-to-speech to the existing voice assistant
 *      (`voiceAssistant.speak`) which already supports Piper / Coqui / Bark /
 *      ElevenLabs and returns a path to the per-clip audio file.
 *   3. If `ffmpeg-static` is installed we concatenate the clips into a single
 *      MP3 in the user's data directory. If it isn't, we still return the
 *      ordered list of clip paths so the renderer can play them sequentially.
 */

import { app } from "electron";
import { spawn } from "node:child_process";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

import log from "electron-log";
import { voiceAssistant } from "../voice_assistant";
import type { TTSRequest } from "../voice_assistant";

const logger = log.scope("podcast_briefing");

export interface BriefingSegment {
  /** Speaker label shown in the manifest (e.g. "Host", "Guest"). */
  speaker?: string;
  /** Body text to read aloud. */
  text: string;
  /** Optional per-segment voice override (model-specific). */
  voice?: string;
  /** Optional per-segment speed override (0.5 \u2013 2.0). */
  speed?: number;
}

export interface BriefingResult {
  /** Path to the combined MP3, if concatenation succeeded. */
  combinedPath: string | null;
  /** Ordered per-segment clip paths. */
  segmentPaths: string[];
  /** Total clip duration in seconds (sum of segments). */
  durationSeconds: number;
  /** Path to a sidecar JSON manifest listing speakers + clip files. */
  manifestPath: string;
  /** Path to a sidecar M3U playlist (always written). */
  playlistPath: string;
}

function tryLoadFfmpegStatic(): string | null {
  try {
    // ffmpeg-static is an optional dependency; load lazily so we never crash
    // the main bundle if the install failed (e.g. offline first-run).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("ffmpeg-static");
    if (typeof mod === "string" && existsSync(mod)) return mod;
    if (mod && typeof mod === "object" && "default" in mod) {
      const p = (mod as { default?: unknown }).default;
      if (typeof p === "string" && existsSync(p)) return p;
    }
  } catch {
    /* not installed */
  }
  // Fall back to system ffmpeg on PATH.
  return "ffmpeg";
}

async function briefingDir(briefingId: string): Promise<string> {
  const root = path.join(app.getPath("userData"), "podcast-briefings", briefingId);
  await mkdir(root, { recursive: true });
  return root;
}

/**
 * Concatenate clips with ffmpeg using the demuxer concat protocol so we don't
 * have to re-encode (faster + lossless for matching codecs).
 */
async function concatWithFfmpeg(
  ffmpegBin: string,
  segmentPaths: string[],
  outputPath: string,
): Promise<void> {
  const listFile = `${outputPath}.list.txt`;
  const body = segmentPaths
    .map((p) => `file '${p.replace(/'/g, "'\\''")}'`)
    .join("\n");
  await writeFile(listFile, body, "utf8");
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(
      ffmpegBin,
      [
        "-y",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        listFile,
        "-c",
        "copy",
        outputPath,
      ],
      { stdio: "ignore" },
    );
    proc.on("error", reject);
    proc.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`ffmpeg exited with code ${code}`)),
    );
  });
  await unlink(listFile).catch(() => {});
}

export interface PackageBriefingInput {
  title: string;
  segments: BriefingSegment[];
  /** Default voice ID for segments without their own. */
  defaultVoice?: string;
}

export async function packageBriefing(
  input: PackageBriefingInput,
): Promise<BriefingResult> {
  if (!input.segments?.length) {
    throw new Error("Briefing must include at least one segment.");
  }
  const briefingId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const dir = await briefingDir(briefingId);

  const segmentPaths: string[] = [];
  let totalDuration = 0;
  for (let i = 0; i < input.segments.length; i++) {
    const seg = input.segments[i];
    const req: TTSRequest = {
      text: seg.text,
      voice: seg.voice ?? input.defaultVoice,
      speed: seg.speed,
    };
    const res = await voiceAssistant.speak(req);
    segmentPaths.push(res.audioPath);
    totalDuration += res.duration ?? 0;
  }

  // Write a JSON manifest + M3U playlist regardless of whether ffmpeg works.
  const manifestPath = path.join(dir, "manifest.json");
  await writeFile(
    manifestPath,
    JSON.stringify(
      {
        id: briefingId,
        title: input.title,
        createdAt: new Date().toISOString(),
        durationSeconds: totalDuration,
        segments: input.segments.map((s, i) => ({
          index: i,
          speaker: s.speaker ?? null,
          text: s.text,
          audioPath: segmentPaths[i],
        })),
      },
      null,
      2,
    ),
    "utf8",
  );
  const playlistPath = path.join(dir, "playlist.m3u");
  await writeFile(
    playlistPath,
    ["#EXTM3U", ...segmentPaths].join("\n"),
    "utf8",
  );

  // Attempt concatenation.
  let combinedPath: string | null = null;
  const ext = path.extname(segmentPaths[0] || "").toLowerCase() || ".mp3";
  const outPath = path.join(dir, `briefing${ext}`);
  const ffmpegBin = tryLoadFfmpegStatic();
  if (ffmpegBin) {
    try {
      await concatWithFfmpeg(ffmpegBin, segmentPaths, outPath);
      combinedPath = outPath;
    } catch (err) {
      logger.warn(
        `ffmpeg concat failed (${ffmpegBin}); returning per-segment clips only:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  return {
    combinedPath,
    segmentPaths,
    durationSeconds: totalDuration,
    manifestPath,
    playlistPath,
  };
}
