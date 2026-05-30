import { ipcMain, shell, dialog, app } from "electron";
import { db } from "@/db";
import { videoStudioVideos, videoProjects } from "@/db/schema";
import { readSettings } from "@/main/settings";
import { resolveApiKey } from "@/lib/api_key_resolver";
import { desc, eq, like, or } from "drizzle-orm";
import fs from "node:fs";
import path from "node:path";
import { generateText } from "ai";
import { getModelClient } from "@/ipc/utils/get_model_client";
import { recordAICost } from "@/ipc/utils/cost_tracking";
import { createProvenanceManifest } from "@/types/provenance";
import { getDomainEventBus } from "@/lib/events/domain_event_bus";
import { renderTimeline, probeVideo, extractThumbnail } from "@/lib/video/ffmpeg";
import { timelineDuration, type VideoTimeline } from "@/lib/video/timeline_types";

// ── Types ──────────────────────────────────────────────────────────────────────

interface GenerateVideoParams {
  provider: string;
  model: string;
  prompt: string;
  negativePrompt?: string;
  width: number;
  height: number;
  duration?: number;
  fps?: number;
  seed?: string;
  style?: string;
  sourceType?: string;
  referenceImageBase64?: string;
  referenceVideoId?: number;
  strength?: number;
  motionAmount?: number;
}

interface ListVideosParams {
  limit?: number;
  offset?: number;
  search?: string;
  provider?: string;
}

interface ExtractFramesParams {
  videoId: number;
  count?: number;
}

interface RenderTimelineParams {
  timeline: VideoTimeline;
  projectId?: number;
  projectName?: string;
}

interface CreateProjectParams {
  name?: string;
  timeline?: VideoTimeline;
}

interface UpdateProjectParams {
  id: number;
  name?: string;
  timeline?: VideoTimeline;
}

// ── Storage Directory ──────────────────────────────────────────────────────────

function getVideoStoreDir(): string {
  const dir = path.join(app.getPath("userData"), "video-studio");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function getApiKey(providerName: string): Promise<string> {
  const resolved = await resolveApiKey(providerName);
  if (!resolved) {
    throw new Error(
      `No API key configured for provider: ${providerName}. ` +
      `Add one in Secrets Vault → API Keys tab, or in Settings → Providers.`
    );
  }
  return resolved.value;
}

// ── Video Saving Utility ───────────────────────────────────────────────────────

async function saveBinaryVideo(data: Buffer, filename: string): Promise<string> {
  const dir = getVideoStoreDir();
  const filePath = path.join(dir, filename);
  fs.writeFileSync(filePath, data);
  return filePath;
}

function uniqueVideoFilename(provider: string, ext = "mp4"): string {
  return `${provider}_${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`;
}

async function saveThumbnailFromUrl(videoUrl: string, provider: string): Promise<string | null> {
  // For providers that return a thumbnail URL along with video, we save it.
  // Otherwise we return null and the client-side player generates the thumb.
  try {
    const dir = getVideoStoreDir();
    const thumbFilename = `thumb_${provider}_${Date.now()}_${Math.random().toString(36).slice(2)}.jpg`;
    const thumbPath = path.join(dir, thumbFilename);
    // Fetch first frame from the video URL as an image if available
    // For now, return null — thumbnails generated client-side
    void videoUrl;
    void thumbPath;
    return null;
  } catch {
    return null;
  }
}

// ── Provider Implementations ───────────────────────────────────────────────────

async function generateWithRunway(params: GenerateVideoParams): Promise<{ filePath: string; thumbnailPath: string | null }> {
  const apiKey = await getApiKey("runway");

  const body: Record<string, unknown> = {
    model: params.model || "gen3a_turbo",
    promptText: params.prompt,
    duration: params.duration ?? 5,
    ratio: `${params.width}:${params.height}`,
  };

  if (params.referenceImageBase64) {
    body.promptImage = params.referenceImageBase64.startsWith("data:")
      ? params.referenceImageBase64
      : `data:image/png;base64,${params.referenceImageBase64}`;
  }

  if (params.seed) body.seed = parseInt(params.seed, 10);

  const res = await fetch("https://api.runwayml.com/v1/image_to_video", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "X-Runway-Version": "2024-11-06",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Runway error: ${err}`);
  }

  const { id } = await res.json();

  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const pollRes = await fetch(`https://api.runwayml.com/v1/tasks/${id}`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "X-Runway-Version": "2024-11-06",
      },
    });
    const task = await pollRes.json();
    if (task.status === "SUCCEEDED") {
      const videoUrl = task.output?.[0];
      if (!videoUrl) throw new Error("Runway succeeded but no output URL");
      const videoRes = await fetch(videoUrl);
      const buffer = Buffer.from(await videoRes.arrayBuffer());
      const filePath = await saveBinaryVideo(buffer, uniqueVideoFilename("runway"));
      const thumbnailPath = await saveThumbnailFromUrl(videoUrl, "runway");
      return { filePath, thumbnailPath };
    }
    if (task.status === "FAILED") {
      throw new Error(`Runway task failed: ${task.failure}`);
    }
  }

  throw new Error("Runway task timed out after 360 seconds");
}

async function generateWithFal(params: GenerateVideoParams): Promise<{ filePath: string; thumbnailPath: string | null }> {
  const apiKey = await getApiKey("fal");
  const model = params.model || "fal-ai/kling-video/v2/master/text-to-video";

  const body: Record<string, unknown> = {
    prompt: params.prompt,
    duration: `${params.duration ?? 5}`,
    aspect_ratio: `${params.width}:${params.height}`,
  };

  if (params.negativePrompt) body.negative_prompt = params.negativePrompt;

  if (params.referenceImageBase64) {
    body.image_url = params.referenceImageBase64.startsWith("data:")
      ? params.referenceImageBase64
      : `data:image/png;base64,${params.referenceImageBase64}`;
  }

  if (params.seed) body.seed = parseInt(params.seed, 10);

  const submitRes = await fetch(`https://queue.fal.run/${model}`, {
    method: "POST",
    headers: {
      Authorization: `Key ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!submitRes.ok) {
    const err = await submitRes.text();
    throw new Error(`Fal.ai submit error: ${err}`);
  }

  const { request_id, status_url } = await submitRes.json();
  const pollBase = status_url || `https://queue.fal.run/${model}/requests/${request_id}`;

  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const pollRes = await fetch(`${pollBase}/status`, {
      headers: { Authorization: `Key ${apiKey}` },
    });
    const status = await pollRes.json();
    if (status.status === "COMPLETED") {
      const resultRes = await fetch(pollBase, {
        headers: { Authorization: `Key ${apiKey}` },
      });
      const result = await resultRes.json();
      const videoUrl = result.video?.url;
      if (!videoUrl) throw new Error("Fal.ai completed but no video URL");
      const videoRes = await fetch(videoUrl);
      const buffer = Buffer.from(await videoRes.arrayBuffer());
      const filePath = await saveBinaryVideo(buffer, uniqueVideoFilename("fal"));
      const thumbnailPath = await saveThumbnailFromUrl(videoUrl, "fal");
      return { filePath, thumbnailPath };
    }
    if (status.status === "FAILED") {
      throw new Error(`Fal.ai job failed: ${JSON.stringify(status.error)}`);
    }
  }

  throw new Error("Fal.ai job timed out after 360 seconds");
}

async function generateWithReplicate(params: GenerateVideoParams): Promise<{ filePath: string; thumbnailPath: string | null }> {
  const apiKey = await getApiKey("replicate");
  const modelVersion = params.model || "cjwbw/cogvideox-5b:latest";

  const input: Record<string, unknown> = {
    prompt: params.prompt,
    num_frames: Math.round((params.duration ?? 5) * (params.fps ?? 24)),
    width: params.width,
    height: params.height,
    fps: params.fps ?? 24,
  };

  if (params.negativePrompt) input.negative_prompt = params.negativePrompt;
  if (params.seed) input.seed = parseInt(params.seed, 10);

  if (params.referenceImageBase64) {
    input.image = params.referenceImageBase64.startsWith("data:")
      ? params.referenceImageBase64
      : `data:image/png;base64,${params.referenceImageBase64}`;
    input.strength = params.strength ?? 0.75;
  }

  const createRes = await fetch("https://api.replicate.com/v1/predictions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      version: modelVersion,
      input,
    }),
  });

  if (!createRes.ok) {
    const err = await createRes.text();
    throw new Error(`Replicate create error: ${err}`);
  }

  const prediction = await createRes.json();
  const pollUrl = prediction.urls?.get;
  if (!pollUrl) throw new Error("Replicate returned no poll URL");

  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const pollRes = await fetch(pollUrl, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const status = await pollRes.json();
    if (status.status === "succeeded") {
      const videoUrl = Array.isArray(status.output) ? status.output[0] : status.output;
      if (!videoUrl) throw new Error("Replicate succeeded but no output URL");
      const videoRes = await fetch(videoUrl);
      const buffer = Buffer.from(await videoRes.arrayBuffer());
      const filePath = await saveBinaryVideo(buffer, uniqueVideoFilename("replicate"));
      const thumbnailPath = await saveThumbnailFromUrl(videoUrl, "replicate");
      return { filePath, thumbnailPath };
    }
    if (status.status === "failed") {
      throw new Error(`Replicate job failed: ${status.error}`);
    }
  }

  throw new Error("Replicate job timed out after 360 seconds");
}

async function generateWithLuma(params: GenerateVideoParams): Promise<{ filePath: string; thumbnailPath: string | null }> {
  const apiKey = await getApiKey("luma");

  const body: Record<string, unknown> = {
    prompt: params.prompt,
    model: params.model || "ray2",
    resolution: params.width >= 1920 ? "1080p" : params.width >= 1280 ? "720p" : "540p",
    duration: `${params.duration ?? 5}s`,
  };

  if (params.referenceImageBase64) {
    body.keyframes = {
      frame0: {
        type: "image",
        url: params.referenceImageBase64.startsWith("data:")
          ? params.referenceImageBase64
          : `data:image/png;base64,${params.referenceImageBase64}`,
      },
    };
  }

  // Extend from existing video
  if (params.sourceType === "extend" && params.referenceVideoId) {
    const existing = await db
      .select()
      .from(videoStudioVideos)
      .where(eq(videoStudioVideos.id, params.referenceVideoId))
      .limit(1);
    if (existing[0]) {
      const videoData = fs.readFileSync(existing[0].filePath);
      const b64 = videoData.toString("base64");
      body.keyframes = {
        frame0: {
          type: "video",
          url: `data:video/mp4;base64,${b64}`,
        },
      };
    }
  }

  const res = await fetch("https://api.lumalabs.ai/dream-machine/v1/generations", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Luma AI error: ${err}`);
  }

  const { id } = await res.json();

  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const pollRes = await fetch(`https://api.lumalabs.ai/dream-machine/v1/generations/${id}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const gen = await pollRes.json();
    if (gen.state === "completed") {
      const videoUrl = gen.assets?.video;
      if (!videoUrl) throw new Error("Luma completed but no video URL");
      const videoRes = await fetch(videoUrl);
      const buffer = Buffer.from(await videoRes.arrayBuffer());
      const filePath = await saveBinaryVideo(buffer, uniqueVideoFilename("luma"));
      const thumbUrl = gen.assets?.thumbnail;
      let thumbnailPath: string | null = null;
      if (thumbUrl) {
        const thumbRes = await fetch(thumbUrl);
        const thumbBuf = Buffer.from(await thumbRes.arrayBuffer());
        const thumbFile = `thumb_luma_${Date.now()}.jpg`;
        const dir = getVideoStoreDir();
        thumbnailPath = path.join(dir, thumbFile);
        fs.writeFileSync(thumbnailPath, thumbBuf);
      }
      return { filePath, thumbnailPath };
    }
    if (gen.state === "failed") {
      throw new Error(`Luma generation failed: ${gen.failure_reason}`);
    }
  }

  throw new Error("Luma generation timed out after 360 seconds");
}

async function generateWithStabilityAI(params: GenerateVideoParams): Promise<{ filePath: string; thumbnailPath: string | null }> {
  const apiKey = await getApiKey("stabilityai");

  if (!params.referenceImageBase64) {
    throw new Error("Stability AI video generation requires a reference image (image-to-video only)");
  }

  // Convert base64 to blob for FormData
  const base64Data = params.referenceImageBase64.replace(/^data:image\/\w+;base64,/, "");
  const imageBuffer = Buffer.from(base64Data, "base64");
  const blob = new Blob([imageBuffer], { type: "image/png" });

  const formData = new FormData();
  formData.append("image", blob, "reference.png");
  formData.append("seed", params.seed ?? "0");
  formData.append("cfg_scale", "2.5");
  formData.append("motion_bucket_id", String(params.motionAmount ?? 127));

  const res = await fetch("https://api.stability.ai/v2beta/image-to-video", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    body: formData,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Stability AI error: ${err}`);
  }

  const { id } = await res.json();

  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const pollRes = await fetch(`https://api.stability.ai/v2beta/image-to-video/result/${id}`, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "video/*" },
    });

    if (pollRes.status === 200) {
      const buffer = Buffer.from(await pollRes.arrayBuffer());
      const filePath = await saveBinaryVideo(buffer, uniqueVideoFilename("stabilityai"));
      return { filePath, thumbnailPath: null };
    }
    if (pollRes.status !== 202) {
      const err = await pollRes.text();
      throw new Error(`Stability AI poll error: ${err}`);
    }
  }

  throw new Error("Stability AI video generation timed out after 360 seconds");
}

async function generateWithGoogleVeo(params: GenerateVideoParams): Promise<{ filePath: string; thumbnailPath: string | null }> {
  const apiKey = await getApiKey("google");
  const model = params.model || "veo-3.0-generate-001";

  const instance: Record<string, unknown> = {
    prompt: params.prompt,
  };

  if (params.referenceImageBase64) {
    const base64Data = params.referenceImageBase64.replace(/^data:image\/\w+;base64,/, "");
    const mime = params.referenceImageBase64.match(/^data:(image\/\w+);base64,/)?.[1] || "image/png";
    instance.image = { bytesBase64Encoded: base64Data, mimeType: mime };
  }

  // Veo accepts a fixed list of aspect ratios — derive from width/height.
  const ratio = params.width && params.height ? params.width / params.height : 16 / 9;
  const aspectRatio = ratio >= 1.5 ? "16:9" : ratio <= 0.7 ? "9:16" : "1:1";

  // Veo requires durationSeconds in [4, 8] (inclusive). Clamp so UI presets
  // like 3s or 10s don't get rejected by the API.
  const veoDuration = Math.max(4, Math.min(8, Math.round(params.duration ?? 5)));

  // personGeneration values are model-family specific:
  //   - Veo 3.x  → "allow_all" | "dont_allow"
  //   - Veo 2.x  → "allow_adult" | "dont_allow"
  // For image-to-video, Veo locks person generation regardless, so omit it
  // to avoid "not supported" errors.
  const isVeo3 = /^veo-3/.test(model);
  const isImageToVideo = Boolean(instance.image);
  const personGeneration = isImageToVideo
    ? undefined
    : isVeo3
      ? "allow_all"
      : "allow_adult";

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:predictLongRunning?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instances: [instance],
        parameters: {
          aspectRatio,
          durationSeconds: veoDuration,
          ...(personGeneration ? { personGeneration } : {}),
          ...(params.negativePrompt ? { negativePrompt: params.negativePrompt } : {}),
        },
      }),
    },
  );

  if (!res.ok) {
    const err = await res.text();
    throw friendlyGoogleVeoError(err, model);
  }

  const { name } = await res.json();
  if (!name) throw new Error("Google Veo returned no operation name");

  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const pollRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/${name}?key=${apiKey}`,
    );
    const op = await pollRes.json();
    if (op.done) {
      const videoUri = op.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri;
      if (!videoUri) throw new Error("Google Veo completed but no video URI");
      const videoRes = await fetch(`${videoUri}&key=${apiKey}`);
      const buffer = Buffer.from(await videoRes.arrayBuffer());
      const filePath = await saveBinaryVideo(buffer, uniqueVideoFilename("google"));
      return { filePath, thumbnailPath: null };
    }
    if (op.error) {
      throw friendlyGoogleVeoError(
        typeof op.error === "string" ? op.error : JSON.stringify(op.error),
        model,
      );
    }
  }

  throw new Error("Google Veo timed out after 600 seconds");
}

/**
 * Veo is paid-tier on the Generative Language API. Surface an actionable
 * message pointing the user at the free local video providers (Replicate
 * free quota or ComfyUI/AnimateDiff when available) instead of a raw JSON
 * dump.
 */
function friendlyGoogleVeoError(rawBody: string, model: string): Error {
  let parsed: { error?: { message?: string } } | null = null;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    /* keep raw */
  }
  const msg = parsed?.error?.message ?? rawBody;
  const isPaidTier =
    /paid plan|billed users|billing|upgrade your account|only available on paid/i.test(msg);
  if (isPaidTier) {
    return new Error(
      `${model} requires a paid Google AI Studio plan. ` +
        `Try a different Video Studio provider (Replicate, Fal.ai, Luma, Runway) or upgrade at https://ai.dev/projects. ` +
        `Raw error: ${msg}`,
    );
  }
  return new Error(`Google Veo error: ${msg}`);
}

async function generateWithOpenAI(params: GenerateVideoParams): Promise<{ filePath: string; thumbnailPath: string | null }> {
  const apiKey = await getApiKey("openai");

  const body: Record<string, unknown> = {
    model: params.model || "sora",
    prompt: params.prompt,
    n: 1,
    size: `${params.width}x${params.height}`,
    duration: params.duration ?? 5,
  };

  if (params.referenceImageBase64) {
    body.image = params.referenceImageBase64.startsWith("data:")
      ? params.referenceImageBase64
      : `data:image/png;base64,${params.referenceImageBase64}`;
  }

  if (params.style) body.style = params.style;

  const res = await fetch("https://api.openai.com/v1/videos/generations", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenAI Sora error: ${err}`);
  }

  const result = await res.json();

  // Sora may return a direct URL or require polling
  let videoUrl = result.data?.[0]?.url;
  if (!videoUrl && result.id) {
    // Poll for completion
    for (let i = 0; i < 120; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      const pollRes = await fetch(`https://api.openai.com/v1/videos/generations/${result.id}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      const pollData = await pollRes.json();
      if (pollData.status === "succeeded") {
        videoUrl = pollData.data?.[0]?.url;
        break;
      }
      if (pollData.status === "failed") {
        throw new Error(`OpenAI Sora generation failed: ${pollData.error?.message ?? "Unknown error"}`);
      }
    }
  }

  if (!videoUrl) throw new Error("OpenAI Sora returned no video URL");

  const videoRes = await fetch(videoUrl);
  const buffer = Buffer.from(await videoRes.arrayBuffer());
  const filePath = await saveBinaryVideo(buffer, uniqueVideoFilename("openai"));
  return { filePath, thumbnailPath: null };
}

// ── Provider Dispatch ──────────────────────────────────────────────────────────

async function dispatchGenerate(params: GenerateVideoParams): Promise<{ filePath: string; thumbnailPath: string | null }> {
  switch (params.provider) {
    case "runway":
      return generateWithRunway(params);
    case "fal":
      return generateWithFal(params);
    case "replicate":
      return generateWithReplicate(params);
    case "luma":
      return generateWithLuma(params);
    case "stabilityai":
      return generateWithStabilityAI(params);
    case "google":
      return generateWithGoogleVeo(params);
    case "openai":
      return generateWithOpenAI(params);
    default:
      throw new Error(`Unsupported video provider: ${params.provider}`);
  }
}

// ── Provider Catalog ───────────────────────────────────────────────────────────

interface ProviderModel {
  id: string;
  label: string;
  supportsImg2Video?: boolean;
  supportsVideoExtend?: boolean;
  supportsVideo2Video?: boolean;
  maxDurationSeconds?: number;
  minDurationSeconds?: number;
  defaultFps?: number;
  comingSoon?: boolean;
}

interface ProviderCatalogEntry {
  label: string;
  models: ProviderModel[];
  kind?: "cloud" | "local";
  website?: string;
  apiKeyEnvVars?: string[];
  comingSoon?: boolean;
}

function getProviderCatalog(): Record<string, ProviderCatalogEntry> {
  return {
    runway: {
      label: "Runway",
      kind: "cloud",
      website: "https://app.runwayml.com/account",
      apiKeyEnvVars: ["RUNWAY_API_KEY", "RUNWAYML_API_SECRET"],
      models: [
        { id: "gen3a_turbo", label: "Gen-3 Alpha Turbo", supportsImg2Video: true, maxDurationSeconds: 10, defaultFps: 24 },
        { id: "gen4_turbo", label: "Gen-4 Turbo", supportsImg2Video: true, maxDurationSeconds: 10, defaultFps: 24 },
      ],
    },
    fal: {
      label: "Fal.ai",
      kind: "cloud",
      website: "https://fal.ai/dashboard/keys",
      apiKeyEnvVars: ["FAL_KEY", "FAL_API_KEY"],
      models: [
        { id: "fal-ai/kling-video/v2/master/text-to-video", label: "Kling v2 (Text)", maxDurationSeconds: 10, defaultFps: 24 },
        { id: "fal-ai/kling-video/v2/master/image-to-video", label: "Kling v2 (Image)", supportsImg2Video: true, maxDurationSeconds: 10, defaultFps: 24 },
        { id: "fal-ai/minimax-video/video-01-live", label: "Minimax Video-01 Live", maxDurationSeconds: 6, defaultFps: 24 },
        { id: "fal-ai/minimax-video/video-01", label: "Minimax Video-01", maxDurationSeconds: 6, defaultFps: 24 },
        { id: "fal-ai/cogvideox-5b", label: "CogVideoX 5B", maxDurationSeconds: 6, defaultFps: 16 },
        { id: "fal-ai/hunyuan-video", label: "HunyuanVideo", maxDurationSeconds: 5, defaultFps: 24 },
      ],
    },
    replicate: {
      label: "Replicate",
      kind: "cloud",
      website: "https://replicate.com/account/api-tokens",
      apiKeyEnvVars: ["REPLICATE_API_TOKEN"],
      models: [
        { id: "cjwbw/cogvideox-5b:latest", label: "CogVideoX 5B", maxDurationSeconds: 6, defaultFps: 16 },
        { id: "stability-ai/stable-video-diffusion:latest", label: "Stable Video Diffusion", supportsImg2Video: true, maxDurationSeconds: 4, defaultFps: 14 },
        { id: "tencent/hunyuan-video:latest", label: "HunyuanVideo", maxDurationSeconds: 5, defaultFps: 24 },
      ],
    },
    luma: {
      label: "Luma AI",
      kind: "cloud",
      website: "https://lumalabs.ai/dream-machine/api",
      apiKeyEnvVars: ["LUMA_API_KEY"],
      models: [
        { id: "ray2", label: "Ray 2", supportsImg2Video: true, supportsVideoExtend: true, maxDurationSeconds: 9, defaultFps: 24 },
        { id: "ray2-flash", label: "Ray 2 Flash", supportsImg2Video: true, supportsVideoExtend: true, maxDurationSeconds: 9, defaultFps: 24 },
      ],
    },
    stabilityai: {
      label: "Stability AI",
      kind: "cloud",
      website: "https://platform.stability.ai/account/keys",
      apiKeyEnvVars: ["STABILITY_API_KEY"],
      models: [
        { id: "svd", label: "Stable Video Diffusion", supportsImg2Video: true, maxDurationSeconds: 4, defaultFps: 14 },
        { id: "svd-xt", label: "SVD-XT (Extended)", supportsImg2Video: true, maxDurationSeconds: 4, defaultFps: 14 },
      ],
    },
    google: {
      label: "Google Veo",
      kind: "cloud",
      website: "https://aistudio.google.com/app/apikey",
      apiKeyEnvVars: ["GOOGLE_AI_API_KEY", "GEMINI_API_KEY"],
      models: [
        { id: "veo-3.0-generate-001", label: "Veo 3", supportsImg2Video: true, minDurationSeconds: 4, maxDurationSeconds: 8, defaultFps: 24 },
        { id: "veo-3.0-fast-generate-001", label: "Veo 3 Fast", supportsImg2Video: true, minDurationSeconds: 4, maxDurationSeconds: 8, defaultFps: 24 },
        { id: "veo-2.0-generate-001", label: "Veo 2", supportsImg2Video: true, minDurationSeconds: 4, maxDurationSeconds: 8, defaultFps: 24 },
        { id: "veo-002", label: "Veo 2 (legacy alias)", supportsImg2Video: true, minDurationSeconds: 4, maxDurationSeconds: 8, defaultFps: 24 },
      ],
    },
    openai: {
      label: "OpenAI Sora",
      kind: "cloud",
      website: "https://platform.openai.com/api-keys",
      apiKeyEnvVars: ["OPENAI_API_KEY"],
      comingSoon: true,
      models: [
        { id: "sora", label: "Sora (no public API yet)", supportsImg2Video: true, maxDurationSeconds: 20, defaultFps: 24, comingSoon: true },
      ],
    },
    pika: {
      label: "Pika Labs",
      kind: "cloud",
      website: "https://pika.art",
      apiKeyEnvVars: ["PIKA_API_KEY"],
      comingSoon: true,
      models: [
        { id: "pika-2.0", label: "Pika 2.0 (waitlist API)", maxDurationSeconds: 5, defaultFps: 24, comingSoon: true },
      ],
    },
    xai: {
      label: "Grok Video (xAI)",
      kind: "cloud",
      website: "https://console.x.ai",
      apiKeyEnvVars: ["XAI_API_KEY"],
      comingSoon: true,
      models: [
        { id: "grok-video", label: "Grok Video (coming soon)", maxDurationSeconds: 6, defaultFps: 24, comingSoon: true },
      ],
    },
  };
}

// ── Handler Registration ───────────────────────────────────────────────────────

export function registerVideoStudioHandlers() {
  // ── Generate ─────────────────────────────────────────────────────────────
  ipcMain.handle("video-studio:generate", async (_, params: GenerateVideoParams) => {
    if (!params.prompt?.trim()) throw new Error("Prompt is required");
    if (!params.provider) throw new Error("Provider is required");

    const sourceType = params.sourceType ?? "text-to-video";

    const generationStartedAt = Date.now();
    const { filePath, thumbnailPath } = await dispatchGenerate(params);

    // DEAI Phase 0D — provenance manifest at generation time.
    const provenance = createProvenanceManifest({
      model: params.model || "unknown",
      provider: params.provider,
      prompt: params.prompt.trim(),
      negativePrompt: params.negativePrompt?.trim() || undefined,
      params: {
        width: params.width,
        height: params.height,
        duration: params.duration ?? 5,
        fps: params.fps ?? 24,
        seed: params.seed || null,
        style: params.style || null,
        sourceType,
        strength: params.strength,
        motionAmount: params.motionAmount,
      },
    });

    const [row] = await db
      .insert(videoStudioVideos)
      .values({
        prompt: params.prompt.trim(),
        negativePrompt: params.negativePrompt?.trim() || null,
        provider: params.provider,
        model: params.model || "",
        width: params.width,
        height: params.height,
        duration: params.duration ?? 5,
        fps: params.fps ?? 24,
        format: "mp4",
        filePath,
        thumbnailPath,
        seed: params.seed || null,
        style: params.style || null,
        sourceType,
        sourceId: params.referenceVideoId ?? null,
        metadata: {
          strength: params.strength,
          motionAmount: params.motionAmount,
          hasReferenceImage: !!params.referenceImageBase64,
        },
        provenanceJson: provenance,
      })
      .returning();

    // DEAI Phase 0E — emit compute.job.completed for tokenomics/metering.
    void getDomainEventBus().publish("compute.job.completed", {
      jobId: `video-studio:${row?.id ?? "unknown"}`,
      status: "succeeded",
      durationMs: Date.now() - generationStartedAt,
    }).catch(() => { /* swallow */ });

    return row;
  });

  // ── List ──────────────────────────────────────────────────────────────────
  ipcMain.handle("video-studio:list", async (_, params?: ListVideosParams) => {
    const limit = params?.limit ?? 100;
    const offset = params?.offset ?? 0;

    const conditions = [];
    if (params?.search) {
      conditions.push(like(videoStudioVideos.prompt, `%${params.search}%`));
    }
    if (params?.provider) {
      conditions.push(eq(videoStudioVideos.provider, params.provider));
    }

    const whereClause = conditions.length > 0 ? or(...conditions) : undefined;

    return db
      .select()
      .from(videoStudioVideos)
      .where(whereClause)
      .orderBy(desc(videoStudioVideos.createdAt))
      .limit(limit)
      .offset(offset);
  });

  // ── Get ───────────────────────────────────────────────────────────────────
  ipcMain.handle("video-studio:get", async (_, id: number) => {
    const rows = await db
      .select()
      .from(videoStudioVideos)
      .where(eq(videoStudioVideos.id, id))
      .limit(1);
    if (!rows[0]) throw new Error(`Video not found: ${id}`);
    return rows[0];
  });

  // ── Delete ────────────────────────────────────────────────────────────────
  ipcMain.handle("video-studio:delete", async (_, id: number) => {
    const rows = await db
      .select()
      .from(videoStudioVideos)
      .where(eq(videoStudioVideos.id, id))
      .limit(1);
    const row = rows[0];
    if (!row) throw new Error(`Video not found: ${id}`);

    // Remove files
    try {
      if (fs.existsSync(row.filePath)) fs.unlinkSync(row.filePath);
    } catch { /* ignore */ }
    try {
      if (row.thumbnailPath && fs.existsSync(row.thumbnailPath)) fs.unlinkSync(row.thumbnailPath);
    } catch { /* ignore */ }

    await db.delete(videoStudioVideos).where(eq(videoStudioVideos.id, id));
    return { success: true };
  });

  // ── Save to Disk ──────────────────────────────────────────────────────────
  ipcMain.handle("video-studio:save-to-disk", async (_, id: number) => {
    const rows = await db
      .select()
      .from(videoStudioVideos)
      .where(eq(videoStudioVideos.id, id))
      .limit(1);
    const row = rows[0];
    if (!row) throw new Error(`Video not found: ${id}`);

    const ext = path.extname(row.filePath) || ".mp4";
    const result = await dialog.showSaveDialog({
      defaultPath: `video_${id}${ext}`,
      filters: [{ name: "Video", extensions: ["mp4", "webm", "mov"] }],
    });

    if (result.canceled || !result.filePath) return { saved: false };
    fs.copyFileSync(row.filePath, result.filePath);
    return { saved: true, dest: result.filePath };
  });

  // ── Open in Folder ────────────────────────────────────────────────────────
  ipcMain.handle("video-studio:open-in-folder", async (_, id: number) => {
    const rows = await db
      .select()
      .from(videoStudioVideos)
      .where(eq(videoStudioVideos.id, id))
      .limit(1);
    const row = rows[0];
    if (!row) throw new Error(`Video not found: ${id}`);
    shell.showItemInFolder(row.filePath);
  });

  // ── Available Providers ───────────────────────────────────────────────────
  ipcMain.handle("video-studio:available-providers", async () => {
    const catalog = getProviderCatalog();
    const result: Array<{
      id: string;
      label: string;
      models: ProviderModel[];
      configured?: boolean;
      kind?: "cloud" | "local";
      website?: string;
      apiKeyEnvVars?: string[];
      comingSoon?: boolean;
    }> = [];

    for (const [providerId, info] of Object.entries(catalog)) {
      let configured = false;
      if (!info.comingSoon) {
        const resolved = await resolveApiKey(providerId);
        configured = !!resolved;
      }
      result.push({
        id: providerId,
        label: info.label,
        models: info.models,
        kind: info.kind ?? "cloud",
        website: info.website,
        apiKeyEnvVars: info.apiKeyEnvVars,
        comingSoon: info.comingSoon,
        configured,
      });
    }

    return result;
  });

  // ── Read Video ────────────────────────────────────────────────────────────
  ipcMain.handle("video-studio:read-video", async (_, id: number) => {
    const rows = await db
      .select()
      .from(videoStudioVideos)
      .where(eq(videoStudioVideos.id, id))
      .limit(1);
    const row = rows[0];
    if (!row) throw new Error(`Video not found: ${id}`);
    if (!fs.existsSync(row.filePath)) throw new Error(`Video file missing: ${row.filePath}`);

    const buffer = fs.readFileSync(row.filePath);
    const ext = path.extname(row.filePath).replace(".", "") || "mp4";
    return `data:video/${ext};base64,${buffer.toString("base64")}`;
  });

  // ── Read Thumbnail ────────────────────────────────────────────────────────
  ipcMain.handle("video-studio:read-thumbnail", async (_, id: number) => {
    const rows = await db
      .select()
      .from(videoStudioVideos)
      .where(eq(videoStudioVideos.id, id))
      .limit(1);
    const row = rows[0];
    if (!row) throw new Error(`Video not found: ${id}`);

    if (row.thumbnailPath && fs.existsSync(row.thumbnailPath)) {
      const buffer = fs.readFileSync(row.thumbnailPath);
      return `data:image/jpeg;base64,${buffer.toString("base64")}`;
    }

    // No cached thumbnail — return empty string so client generates one
    return "";
  });

  // ── Enhance Prompt ────────────────────────────────────────────────────────
  ipcMain.handle("video-studio:enhance-prompt", async (_, prompt: string) => {
    if (!prompt.trim()) throw new Error("Prompt is required");

    const settings = readSettings();
    const { modelClient } = await getModelClient(settings.selectedModel, settings);

    const { text, usage } = await generateText({
      model: modelClient.model,
      system: `You are an expert AI video prompt engineer. Your task is to enhance the user's video generation prompt to produce the best possible results.

Rules:
- Expand the prompt with specific cinematic details: camera movement (dolly, pan, tilt, tracking shot, crane shot), lighting (golden hour, harsh overhead, soft diffused), motion dynamics (slow motion, time-lapse, smooth flow)
- Add temporal pacing cues: "begins with...", "transitions to...", "ends on..."
- Include texture and atmosphere details: fog, particles, reflections, depth of field, lens flare
- Specify movement quality: fluid, dynamic, gentle, dramatic, energetic
- Keep it under 200 words
- Return ONLY the enhanced prompt — no explanations or markdown`,
      prompt: `Enhance this video prompt:\n\n${prompt.trim()}`,
      maxOutputTokens: 400,
    });
    recordAICost({ model: settings.selectedModel?.name ?? "unknown", provider: modelClient.builtinProviderId ?? settings.selectedModel?.provider ?? "unknown", inputTokens: usage?.promptTokens ?? 0, outputTokens: usage?.completionTokens ?? 0, taskType: "video-enhance", source: "agent" });

    return text.trim();
  });

  // ── Extract Frames ────────────────────────────────────────────────────────
  ipcMain.handle("video-studio:extract-frames", async (_, params: ExtractFramesParams) => {
    const rows = await db
      .select()
      .from(videoStudioVideos)
      .where(eq(videoStudioVideos.id, params.videoId))
      .limit(1);
    const row = rows[0];
    if (!row) throw new Error(`Video not found: ${params.videoId}`);

    // We return the video path + metadata so the client can extract frames via canvas.
    // For server-side multi-frame extraction, ffmpeg would be needed.
    // This returns the video data URL for client-side processing.
    const buffer = fs.readFileSync(row.filePath);
    const ext = path.extname(row.filePath).replace(".", "") || "mp4";
    const dataUrl = `data:video/${ext};base64,${buffer.toString("base64")}`;

    return {
      videoDataUrl: dataUrl,
      duration: row.duration,
      fps: row.fps,
      requestedFrames: params.count ?? 1,
    };
  });

  // ── Probe (accurate duration / resolution / fps) ─────────────────────────
  ipcMain.handle("video-studio:probe", async (_, id: number) => {
    const row = await db
      .select()
      .from(videoStudioVideos)
      .where(eq(videoStudioVideos.id, id))
      .get();
    if (!row) throw new Error(`Video not found: ${id}`);
    if (!fs.existsSync(row.filePath)) throw new Error(`Video file missing: ${row.filePath}`);
    const probe = await probeVideo(row.filePath);
    return {
      duration: probe.duration ?? row.duration,
      width: probe.width ?? row.width,
      height: probe.height ?? row.height,
      fps: probe.fps ?? row.fps,
      hasAudio: probe.hasAudio,
    };
  });

  // ── Render timeline (editor export) ──────────────────────────────────────
  ipcMain.handle("video-studio:render", async (event, params: RenderTimelineParams) => {
    const timeline = params.timeline;
    if (!timeline?.clips?.length) {
      throw new Error("Timeline has no clips to render");
    }

    // Resolve every referenced source video to a file path up front
    // (renderTimeline expects a synchronous resolver).
    const ids = new Set<number>();
    for (const clip of timeline.clips) ids.add(clip.videoId);
    for (const track of timeline.audioTracks ?? []) {
      if (track.videoId != null) ids.add(track.videoId);
    }
    const pathMap = new Map<number, string>();
    for (const id of ids) {
      const row = await db
        .select()
        .from(videoStudioVideos)
        .where(eq(videoStudioVideos.id, id))
        .get();
      if (!row) throw new Error(`Source video not found: ${id}`);
      if (!fs.existsSync(row.filePath)) {
        throw new Error(`Source video file missing: ${row.filePath}`);
      }
      pathMap.set(id, row.filePath);
    }

    const outputPath = path.join(getVideoStoreDir(), uniqueVideoFilename("local-edit"));
    const startedAt = Date.now();

    await renderTimeline({
      timeline,
      outputPath,
      resolveVideoPath: (videoId) => {
        const p = pathMap.get(videoId);
        if (!p) throw new Error(`Unresolved source video: ${videoId}`);
        return p;
      },
      onProgress: (fraction, stage) => {
        try {
          event.sender.send("video-studio:render-progress", { fraction, stage });
        } catch { /* renderer gone */ }
      },
    });

    // Best-effort thumbnail from the first frame.
    let thumbnailPath: string | null = null;
    try {
      const thumb = path.join(
        getVideoStoreDir(),
        `thumb_local-edit_${Date.now()}_${Math.random().toString(36).slice(2)}.jpg`,
      );
      await extractThumbnail(outputPath, 0.1, thumb);
      thumbnailPath = fs.existsSync(thumb) ? thumb : null;
    } catch { thumbnailPath = null; }

    const duration = timelineDuration(timeline);
    const prompt = params.projectName?.trim() || "Video editor render";

    const provenance = createProvenanceManifest({
      model: "video-editor",
      provider: "local",
      prompt,
      params: {
        width: timeline.width,
        height: timeline.height,
        fps: timeline.fps,
        duration,
        clips: timeline.clips.length,
        overlays: timeline.overlays.length,
        audioTracks: timeline.audioTracks.length,
        mode: "timeline-edit",
      },
    });

    const [row] = await db
      .insert(videoStudioVideos)
      .values({
        prompt,
        negativePrompt: null,
        provider: "local",
        model: "video-editor",
        width: timeline.width,
        height: timeline.height,
        duration,
        fps: timeline.fps,
        format: "mp4",
        filePath: outputPath,
        thumbnailPath,
        seed: null,
        style: null,
        sourceType: "edit",
        sourceId: timeline.clips[0]?.videoId ?? null,
        metadata: {
          source: "video-editor",
          projectId: params.projectId ?? null,
          clipCount: timeline.clips.length,
        },
        provenanceJson: provenance,
      })
      .returning();

    if (params.projectId != null && row) {
      await db
        .update(videoProjects)
        .set({ renderedVideoId: row.id, updatedAt: new Date() })
        .where(eq(videoProjects.id, params.projectId));
    }

    void getDomainEventBus().publish("compute.job.completed", {
      jobId: `video-studio:${row?.id ?? "unknown"}`,
      status: "succeeded",
      durationMs: Date.now() - startedAt,
    }).catch(() => { /* swallow */ });

    return row;
  });

  // ── Projects: list ───────────────────────────────────────────────────────
  ipcMain.handle("video-projects:list", async () => {
    return db
      .select()
      .from(videoProjects)
      .orderBy(desc(videoProjects.updatedAt));
  });

  // ── Projects: get ────────────────────────────────────────────────────────
  ipcMain.handle("video-projects:get", async (_, id: number) => {
    const row = await db
      .select()
      .from(videoProjects)
      .where(eq(videoProjects.id, id))
      .get();
    if (!row) throw new Error(`Project not found: ${id}`);
    return row;
  });

  // ── Projects: create ─────────────────────────────────────────────────────
  ipcMain.handle("video-projects:create", async (_, params: CreateProjectParams = {}) => {
    const [row] = await db
      .insert(videoProjects)
      .values({
        name: params.name?.trim() || "Untitled Project",
        timelineJson: (params.timeline as unknown as Record<string, unknown>) ?? null,
      })
      .returning();
    return row;
  });

  // ── Projects: update ─────────────────────────────────────────────────────
  ipcMain.handle("video-projects:update", async (_, params: UpdateProjectParams) => {
    if (params.id == null) throw new Error("Project id is required");
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (params.name != null) patch.name = params.name.trim() || "Untitled Project";
    if (params.timeline != null) {
      patch.timelineJson = params.timeline as unknown as Record<string, unknown>;
    }
    const [row] = await db
      .update(videoProjects)
      .set(patch)
      .where(eq(videoProjects.id, params.id))
      .returning();
    if (!row) throw new Error(`Project not found: ${params.id}`);
    return row;
  });

  // ── Projects: delete ─────────────────────────────────────────────────────
  ipcMain.handle("video-projects:delete", async (_, id: number) => {
    const row = await db
      .select()
      .from(videoProjects)
      .where(eq(videoProjects.id, id))
      .get();
    if (!row) throw new Error(`Project not found: ${id}`);
    if (row.thumbnailPath && fs.existsSync(row.thumbnailPath)) {
      try { fs.unlinkSync(row.thumbnailPath); } catch { /* ignore */ }
    }
    await db.delete(videoProjects).where(eq(videoProjects.id, id));
    return { success: true };
  });
}
