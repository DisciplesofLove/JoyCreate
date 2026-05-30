import { ipcMain, shell, dialog, app } from "electron";
import { db } from "@/db";
import { imageStudioImages } from "@/db/schema";
import { readSettings } from "@/main/settings";
import { resolveApiKey } from "@/lib/api_key_resolver";
import { desc, eq, like, or } from "drizzle-orm";
import fs from "node:fs";
import path from "node:path";
import OpenAI from "openai";
import { generateText } from "ai";
import { getModelClient } from "@/ipc/utils/get_model_client";
import { recordAICost } from "@/ipc/utils/cost_tracking";
import { createProvenanceManifest } from "@/types/provenance";
import { getDomainEventBus } from "@/lib/events/domain_event_bus";

// ── Types ──────────────────────────────────────────────────────────────────────

interface GenerateImageParams {
  provider: string;
  model: string;
  prompt: string;
  negativePrompt?: string;
  width: number;
  height: number;
  style?: string;
  seed?: string;
  batchCount?: number;
  referenceImageBase64?: string;
  strength?: number;
  steps?: number;
  cfgScale?: number;
  sampler?: string;
}

interface EditImageParams {
  imageId: number;
  maskBase64: string;
  prompt: string;
  provider: string;
  model: string;
}

interface ListImagesParams {
  limit?: number;
  offset?: number;
  search?: string;
  provider?: string;
}

interface UpscaleImageParams {
  imageId: number;
  scale?: number;
  provider: string;
}

interface SaveEditedImageParams {
  imageBase64: string;
  sourceImageId?: number;
  prompt?: string;
  width?: number;
  height?: number;
}

// ── Storage Directory ──────────────────────────────────────────────────────────

function getImageStoreDir(): string {
  const dir = path.join(app.getPath("userData"), "image-studio");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

let _apiKeyCache = new Map<string, { value: string; ts: number }>();

async function getApiKeyAsync(providerName: string): Promise<string> {
  // Short TTL cache to avoid repeated vault lookups within a single generation
  const cached = _apiKeyCache.get(providerName);
  if (cached && Date.now() - cached.ts < 30_000) return cached.value;

  const resolved = await resolveApiKey(providerName);
  if (!resolved) {
    throw new Error(
      `No API key configured for provider: ${providerName}. ` +
      `Add one in Secrets Vault → API Keys tab, or in Settings → Providers.`
    );
  }
  _apiKeyCache.set(providerName, { value: resolved.value, ts: Date.now() });
  return resolved.value;
}

/** @deprecated — sync wrapper kept for backward compat; prefer getApiKeyAsync */
function getApiKey(providerName: string): string {
  const settings = readSettings();
  const prov = settings.providerSettings[providerName];
  const key = prov?.apiKey?.value;
  if (!key) throw new Error(`No API key configured for provider: ${providerName}`);
  return key;
}

// ── Image Saving Utility ───────────────────────────────────────────────────────

async function saveBase64Image(base64: string, filename: string): Promise<string> {
  const dir = getImageStoreDir();
  const filePath = path.join(dir, filename);
  const buffer = Buffer.from(base64, "base64");
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

async function saveBinaryImage(data: Buffer, filename: string): Promise<string> {
  const dir = getImageStoreDir();
  const filePath = path.join(dir, filename);
  fs.writeFileSync(filePath, data);
  return filePath;
}

function uniqueFilename(provider: string): string {
  return `${provider}_${Date.now()}_${Math.random().toString(36).slice(2)}.png`;
}

// ── Provider Implementations ───────────────────────────────────────────────────

async function generateWithOpenAI(params: GenerateImageParams): Promise<string> {
  const apiKey = await getApiKeyAsync("openai");
  const openai = new OpenAI({ apiKey });

  const validSizes = ["256x256", "512x512", "1024x1024", "1792x1024", "1024x1792"] as const;
  const sizeStr = `${params.width}x${params.height}`;
  const size = validSizes.includes(sizeStr as (typeof validSizes)[number])
    ? (sizeStr as (typeof validSizes)[number])
    : "1024x1024";

  const response = await openai.images.generate({
    model: params.model || "dall-e-3",
    prompt: params.prompt,
    n: 1,
    size,
    response_format: "b64_json",
    ...(params.style ? { style: params.style as "vivid" | "natural" } : {}),
  });

  const b64 = response.data?.[0]?.b64_json ?? null;
  if (b64 === null) throw new Error("OpenAI returned no image data");
  return saveBase64Image(b64, uniqueFilename("openai"));
}

async function generateWithGoogle(params: GenerateImageParams): Promise<string> {
  const apiKey = await getApiKeyAsync("google");
  const model = params.model || "imagen-4.0-generate-001";

  // Gemini native image generation models use generateContent (multimodal) — different shape than Imagen.
  if (model.startsWith("gemini-")) {
    const parts: Array<Record<string, unknown>> = [{ text: params.prompt }];
    if (params.referenceImageBase64) {
      const b64 = params.referenceImageBase64.replace(/^data:image\/\w+;base64,/, "");
      const mime = params.referenceImageBase64.match(/^data:(image\/\w+);base64,/)?.[1] || "image/png";
      parts.push({ inlineData: { mimeType: mime, data: b64 } });
    }

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts }],
          generationConfig: { responseModalities: ["IMAGE", "TEXT"] },
        }),
      },
    );

    if (!res.ok) {
      const err = await res.text();
      throw friendlyGoogleImageError(err, model);
    }

    const data = await res.json();
    const candidateParts = data?.candidates?.[0]?.content?.parts ?? [];
    const imagePart = candidateParts.find(
      (p: { inlineData?: { data?: string } }) => p?.inlineData?.data,
    );
    const b64 = imagePart?.inlineData?.data;
    if (!b64) throw new Error("Gemini returned no image data");
    return saveBase64Image(b64, uniqueFilename("google"));
  }

  // Imagen 3/4 — predict endpoint
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:predict?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instances: [{ prompt: params.prompt }],
        parameters: {
          sampleCount: 1,
          aspectRatio: aspectRatioFor(params.width, params.height),
          ...(params.negativePrompt ? { negativePrompt: params.negativePrompt } : {}),
          personGeneration: "allow_adult",
        },
      }),
    },
  );

  if (!response.ok) {
    const err = await response.text();
    throw friendlyGoogleImageError(err, model);
  }

  const data = await response.json();
  const b64 = data.predictions?.[0]?.bytesBase64Encoded;
  if (!b64) throw new Error("Google Imagen returned no image data");
  return saveBase64Image(b64, uniqueFilename("google"));
}

/**
 * Translate raw Google Generative Language API error payloads into
 * actionable messages. Most Imagen/Veo failures are billing-tier rejections
 * ("paid plan required"), which the user can work around by switching to a
 * free model (Gemini 2.5 Flash Image / Nano-Banana) or running a local
 * provider (ComfyUI, LocalAI, Automatic1111).
 */
function friendlyGoogleImageError(rawBody: string, model: string): Error {
  let parsed: { error?: { message?: string; status?: string; code?: number } } | null = null;
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
        `Free alternatives in JoyCreate: switch the model to "Gemini 2.5 Flash Image (Nano-Banana)" ` +
        `(also under the Google provider, free tier), or pick a local provider such as ComfyUI / LocalAI / A1111. ` +
        `To enable Imagen, upgrade at https://ai.dev/projects. Raw error: ${msg}`,
    );
  }
  return new Error(`Google Imagen error: ${msg}`);
}

function aspectRatioFor(width?: number, height?: number): string {
  if (!width || !height) return "1:1";
  const ratio = width / height;
  // Imagen supports a fixed list of aspect ratios.
  if (ratio >= 1.7) return "16:9";
  if (ratio >= 1.25) return "4:3";
  if (ratio >= 0.85) return "1:1";
  if (ratio >= 0.6) return "3:4";
  return "9:16";
}

async function generateWithStabilityAI(params: GenerateImageParams): Promise<string> {
  const apiKey = await getApiKeyAsync("stabilityai");

  const formData = new FormData();
  formData.append("prompt", params.prompt);
  if (params.negativePrompt) formData.append("negative_prompt", params.negativePrompt);
  formData.append("output_format", "png");

  // Determine endpoint based on model and img2img mode
  let endpoint = "https://api.stability.ai/v2beta/stable-image/generate/ultra";
  const model = params.model || "stable-image-ultra";

  if (model.startsWith("sd3")) {
    endpoint = "https://api.stability.ai/v2beta/stable-image/generate/sd3";
    formData.append("model", model);
  } else if (model === "stable-image-core") {
    endpoint = "https://api.stability.ai/v2beta/stable-image/generate/core";
  }

  if (params.referenceImageBase64) {
    const b64 = params.referenceImageBase64.replace(/^data:image\/\w+;base64,/, "");
    formData.append("image", new Blob([Buffer.from(b64, "base64")], { type: "image/png" }), "image.png");
    formData.append("strength", String(params.strength ?? 0.65));
    formData.append("mode", "image-to-image");
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "image/*",
    },
    body: formData,
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Stability AI error ${response.status}: ${err}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  return saveBinaryImage(buffer, uniqueFilename("stabilityai"));
}

async function generateWithReplicate(params: GenerateImageParams): Promise<string> {
  const apiKey = await getApiKeyAsync("replicate");
  const modelVersion = params.model || "black-forest-labs/flux-schnell";

  const input: Record<string, unknown> = {
    prompt: params.prompt,
    negative_prompt: params.negativePrompt,
    width: params.width,
    height: params.height,
    num_outputs: 1,
  };

  if (params.referenceImageBase64) {
    input.image = params.referenceImageBase64.startsWith("data:")
      ? params.referenceImageBase64
      : `data:image/png;base64,${params.referenceImageBase64}`;
    input.prompt_strength = params.strength ?? 0.75;
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

  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const pollRes = await fetch(pollUrl, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const status = await pollRes.json();
    if (status.status === "succeeded") {
      const imageUrl = status.output?.[0];
      if (!imageUrl) throw new Error("Replicate succeeded but no output URL");
      const imgRes = await fetch(imageUrl);
      const buffer = Buffer.from(await imgRes.arrayBuffer());
      return saveBinaryImage(buffer, uniqueFilename("replicate"));
    }
    if (status.status === "failed") {
      throw new Error(`Replicate job failed: ${status.error}`);
    }
  }

  throw new Error("Replicate job timed out after 120 seconds");
}

async function generateWithFal(params: GenerateImageParams): Promise<string> {
  const apiKey = await getApiKeyAsync("fal");
  const model = params.model || "fal-ai/flux/dev";

  const body: Record<string, unknown> = {
    prompt: params.prompt,
    negative_prompt: params.negativePrompt,
    image_size: { width: params.width, height: params.height },
    num_images: 1,
  };

  if (params.referenceImageBase64) {
    body.image_url = params.referenceImageBase64.startsWith("data:")
      ? params.referenceImageBase64
      : `data:image/png;base64,${params.referenceImageBase64}`;
    body.strength = params.strength ?? 0.75;
  }

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

  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const pollRes = await fetch(`${pollBase}/status`, {
      headers: { Authorization: `Key ${apiKey}` },
    });
    const status = await pollRes.json();
    if (status.status === "COMPLETED") {
      const resultRes = await fetch(pollBase, {
        headers: { Authorization: `Key ${apiKey}` },
      });
      const result = await resultRes.json();
      const imageUrl = result.images?.[0]?.url;
      if (!imageUrl) throw new Error("Fal.ai completed but no image URL");
      const imgRes = await fetch(imageUrl);
      const buffer = Buffer.from(await imgRes.arrayBuffer());
      return saveBinaryImage(buffer, uniqueFilename("fal"));
    }
    if (status.status === "FAILED") {
      throw new Error(`Fal.ai job failed: ${JSON.stringify(status.error)}`);
    }
  }

  throw new Error("Fal.ai job timed out after 120 seconds");
}

async function generateWithRunway(params: GenerateImageParams): Promise<string> {
  const apiKey = await getApiKeyAsync("runway");

  const res = await fetch("https://api.runwayml.com/v1/image_to_video", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "X-Runway-Version": "2024-11-06",
    },
    body: JSON.stringify({
      model: params.model || "gen3a_turbo",
      promptText: params.prompt,
      ratio: `${params.width}:${params.height}`,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Runway error: ${err}`);
  }

  const { id } = await res.json();

  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const pollRes = await fetch(`https://api.runwayml.com/v1/tasks/${id}`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "X-Runway-Version": "2024-11-06",
      },
    });
    const task = await pollRes.json();
    if (task.status === "SUCCEEDED") {
      const frameUrl = task.output?.[0];
      if (!frameUrl) throw new Error("Runway succeeded but no output URL");
      const imgRes = await fetch(frameUrl);
      const buffer = Buffer.from(await imgRes.arrayBuffer());
      return saveBinaryImage(buffer, uniqueFilename("runway"));
    }
    if (task.status === "FAILED") {
      throw new Error(`Runway task failed: ${task.failure}`);
    }
  }

  throw new Error("Runway task timed out after 180 seconds");
}

async function generateWithComfyUI(params: GenerateImageParams): Promise<string> {
  const clientId = `joycreate_${Date.now()}`;

  const workflow = {
    "3": {
      inputs: {
        seed: params.seed ? parseInt(params.seed, 10) : Math.floor(Math.random() * 2 ** 31),
        steps: params.steps ?? 20,
        cfg: params.cfgScale ?? 7,
        sampler_name: params.sampler ?? "euler",
        scheduler: "normal",
        denoise: params.referenceImageBase64 ? (params.strength ?? 0.75) : 1,
        model: ["4", 0],
        positive: ["6", 0],
        negative: ["7", 0],
        latent_image: ["5", 0],
      },
      class_type: "KSampler",
    },
    "4": { inputs: { ckpt_name: params.model || "v1-5-pruned-emaonly.ckpt" }, class_type: "CheckpointLoaderSimple" },
    "5": { inputs: { width: params.width, height: params.height, batch_size: 1 }, class_type: "EmptyLatentImage" },
    "6": { inputs: { text: params.prompt, clip: ["4", 1] }, class_type: "CLIPTextEncode" },
    "7": { inputs: { text: params.negativePrompt || "", clip: ["4", 1] }, class_type: "CLIPTextEncode" },
    "8": { inputs: { samples: ["3", 0], vae: ["4", 2] }, class_type: "VAEDecode" },
    "9": { inputs: { filename_prefix: "joycreate", images: ["8", 0] }, class_type: "SaveImage" },
  };

  const promptRes = await fetch("http://127.0.0.1:8188/prompt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: workflow, client_id: clientId }),
  });

  if (!promptRes.ok) {
    const err = await promptRes.text();
    throw new Error(`ComfyUI error: ${err}`);
  }

  const { prompt_id } = await promptRes.json();

  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const histRes = await fetch(`http://127.0.0.1:8188/history/${prompt_id}`);
    const hist = await histRes.json();
    const record = hist[prompt_id];
    if (record?.status?.completed) {
      const outputs = record.outputs;
      const nodeOutput = Object.values(outputs)[0] as { images?: { filename: string; subfolder: string; type: string }[] };
      const imgInfo = nodeOutput?.images?.[0];
      if (!imgInfo) throw new Error("ComfyUI completed but no image output");
      const imgRes = await fetch(
        `http://127.0.0.1:8188/view?filename=${encodeURIComponent(imgInfo.filename)}&subfolder=${encodeURIComponent(imgInfo.subfolder)}&type=${encodeURIComponent(imgInfo.type)}`,
      );
      const buffer = Buffer.from(await imgRes.arrayBuffer());
      return saveBinaryImage(buffer, uniqueFilename("comfyui"));
    }
  }

  throw new Error("ComfyUI job timed out after 120 seconds");
}

// ── xAI Grok (OpenAI-compatible) ───────────────────────────────────────────────

async function generateWithXai(params: GenerateImageParams): Promise<string> {
  const apiKey = await getApiKeyAsync("xai");
  const xai = new OpenAI({ apiKey, baseURL: "https://api.x.ai/v1" });
  const response = await xai.images.generate({
    model: params.model || "grok-2-image-1212",
    prompt: params.prompt,
    n: 1,
    response_format: "b64_json",
  });
  const b64 = response.data?.[0]?.b64_json ?? null;
  if (b64 === null) throw new Error("xAI returned no image data");
  return saveBase64Image(b64, uniqueFilename("xai"));
}

// ── Automatic1111 (Local) ──────────────────────────────────────────────────────

async function generateWithA1111(params: GenerateImageParams): Promise<string> {
  const baseUrl = process.env.A1111_URL || "http://127.0.0.1:7860";
  const body: Record<string, unknown> = {
    prompt: params.prompt,
    negative_prompt: params.negativePrompt ?? "",
    width: params.width,
    height: params.height,
    steps: params.steps ?? 20,
    cfg_scale: params.cfgScale ?? 7,
    sampler_name: params.sampler ?? "Euler a",
    seed: params.seed ? Number(params.seed) : -1,
    n_iter: 1,
    batch_size: 1,
  };
  if (params.model && params.model !== "default") {
    body.override_settings = { sd_model_checkpoint: params.model };
  }
  const endpoint = params.referenceImageBase64 ? "/sdapi/v1/img2img" : "/sdapi/v1/txt2img";
  if (params.referenceImageBase64) {
    body.init_images = [params.referenceImageBase64.replace(/^data:image\/[^;]+;base64,/, "")];
    body.denoising_strength = params.strength ?? 0.7;
  }
  const res = await fetch(`${baseUrl}${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`A1111 returned ${res.status}: ${await res.text().catch(() => "unknown error")}`);
  }
  const json = (await res.json()) as { images?: string[] };
  const b64 = json.images?.[0];
  if (!b64) throw new Error("A1111 returned no image");
  return saveBase64Image(b64, uniqueFilename("a1111"));
}

// ── LocalAI ────────────────────────────────────────────────────────────────────

async function generateWithLocalAI(params: GenerateImageParams): Promise<string> {
  const baseUrl = process.env.LOCALAI_URL || "http://127.0.0.1:8080";
  const sizeStr = `${params.width}x${params.height}`;
  const res = await fetch(`${baseUrl}/v1/images/generations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: params.model || "stablediffusion",
      prompt: params.prompt,
      n: 1,
      size: sizeStr,
      response_format: "b64_json",
    }),
  });
  if (!res.ok) {
    throw new Error(`LocalAI returned ${res.status}: ${await res.text().catch(() => "unknown error")}`);
  }
  const json = (await res.json()) as { data?: Array<{ b64_json?: string; url?: string }> };
  const entry = json.data?.[0];
  if (entry?.b64_json) {
    return saveBase64Image(entry.b64_json, uniqueFilename("localai"));
  }
  if (entry?.url) {
    const imgRes = await fetch(entry.url);
    const buf = Buffer.from(await imgRes.arrayBuffer());
    return saveBinaryImage(buf, uniqueFilename("localai"));
  }
  throw new Error("LocalAI returned no image data");
}

// ── Dispatch ───────────────────────────────────────────────────────────────────

/** Generate an image with the given provider/model. Returns the local file path. */
export async function generateImage(params: GenerateImageParams): Promise<string> {
  switch (params.provider) {
    case "openai":
      return generateWithOpenAI(params);
    case "google":
      return generateWithGoogle(params);
    case "stabilityai":
      return generateWithStabilityAI(params);
    case "replicate":
      return generateWithReplicate(params);
    case "fal":
      return generateWithFal(params);
    case "runway":
      return generateWithRunway(params);
    case "comfyui":
      return generateWithComfyUI(params);
    case "xai":
      return generateWithXai(params);
    case "a1111":
      return generateWithA1111(params);
    case "localai":
      return generateWithLocalAI(params);
    case "meta":
      throw new Error("Meta Imagine is not yet supported (no public API).");
    default:
      throw new Error(`Unsupported image provider: ${params.provider}`);
  }
}

// ── Handler Registration ───────────────────────────────────────────────────────

export function registerImageStudioHandlers() {
  ipcMain.handle("image-studio:generate", async (_, params: GenerateImageParams) => {
    if (!params.prompt?.trim()) throw new Error("Prompt is required");
    if (!params.provider) throw new Error("Provider is required");

    const batchCount = Math.min(Math.max(params.batchCount ?? 1, 1), 4);
    const rows = [];
    const generationStartedAt = Date.now();

    for (let i = 0; i < batchCount; i++) {
      const filePath = await generateImage(params);

      const genMeta: Record<string, unknown> = {
        steps: params.steps,
        cfgScale: params.cfgScale,
        sampler: params.sampler,
        batchIndex: batchCount > 1 ? i : undefined,
        hasReferenceImage: !!params.referenceImageBase64,
        strength: params.strength,
      };

      // DEAI Phase 0D — provenance manifest captured at generation time.
      const provenance = createProvenanceManifest({
        model: params.model ?? "unknown",
        provider: params.provider,
        prompt: params.prompt,
        negativePrompt: params.negativePrompt ?? undefined,
        params: {
          width: params.width ?? 1024,
          height: params.height ?? 1024,
          seed: params.seed ?? null,
          style: params.style ?? null,
          steps: params.steps,
          cfgScale: params.cfgScale,
          sampler: params.sampler,
          strength: params.strength,
          batchIndex: batchCount > 1 ? i : undefined,
        },
      });

      const [row] = await db
        .insert(imageStudioImages)
        .values({
          prompt: params.prompt,
          negativePrompt: params.negativePrompt ?? null,
          provider: params.provider,
          model: params.model,
          width: params.width ?? 1024,
          height: params.height ?? 1024,
          filePath,
          seed: params.seed ?? null,
          style: params.style ?? null,
          metadata: genMeta,
          provenanceJson: provenance,
        })
        .returning();
      rows.push(row);
    }

    // DEAI Phase 0E — emit compute.job.completed for tokenomics/metering
    // subscribers. Fire-and-forget; metering must NEVER fail generation.
    void getDomainEventBus().publish("compute.job.completed", {
      jobId: `image-studio:${rows[0]?.id ?? "unknown"}`,
      status: "succeeded",
      durationMs: Date.now() - generationStartedAt,
    }).catch(() => { /* swallow */ });

    return rows;
  });

  ipcMain.handle("image-studio:edit", async (_, params: EditImageParams) => {
    if (params.provider !== "openai") {
      throw new Error("AI image editing is currently only supported with the OpenAI provider");
    }

    const original = await db
      .select()
      .from(imageStudioImages)
      .where(eq(imageStudioImages.id, params.imageId))
      .get();
    if (!original) throw new Error(`Image not found: ${params.imageId}`);

    const apiKey = await getApiKeyAsync("openai");
    const openai = new OpenAI({ apiKey });

    const imageBuffer = fs.readFileSync(original.filePath);
    const maskBuffer = Buffer.from(params.maskBase64.replace(/^data:image\/\w+;base64,/, ""), "base64");

    const imagFile = new File([imageBuffer], "image.png", { type: "image/png" });
    const maskFile = new File([maskBuffer], "mask.png", { type: "image/png" });

    const response = await openai.images.edit({
      image: imagFile,
      mask: maskFile,
      prompt: params.prompt,
      n: 1,
      size: "1024x1024",
      response_format: "b64_json",
    });

    const b64 = response.data?.[0]?.b64_json ?? null;
    if (b64 === null) throw new Error("OpenAI edit returned no image data");

    const filePath = await saveBase64Image(b64, uniqueFilename("openai-edit"));

    const editProvenance = createProvenanceManifest({
      model: params.model || "dall-e-2",
      provider: "openai",
      prompt: params.prompt,
      params: { width: 1024, height: 1024, editedFrom: params.imageId, mode: "edit" },
    });

    const [row] = await db
      .insert(imageStudioImages)
      .values({
        prompt: params.prompt,
        negativePrompt: null,
        provider: params.provider,
        model: params.model || "dall-e-2",
        width: 1024,
        height: 1024,
        filePath,
        seed: null,
        style: null,
        metadata: { editedFrom: params.imageId },
        provenanceJson: editProvenance,
      })
      .returning();

    return row;
  });

  ipcMain.handle("image-studio:save-edited", async (_, params: SaveEditedImageParams) => {
    if (!params.imageBase64?.trim()) throw new Error("Edited image data is required");

    const base64 = params.imageBase64.replace(/^data:image\/\w+;base64,/, "");
    const filePath = await saveBase64Image(base64, uniqueFilename("local-edit"));

    const width = params.width ?? 1024;
    const height = params.height ?? 1024;

    let basePrompt = params.prompt?.trim();
    if (!basePrompt && params.sourceImageId) {
      const original = await db
        .select()
        .from(imageStudioImages)
        .where(eq(imageStudioImages.id, params.sourceImageId))
        .get();
      basePrompt = original?.prompt ? `Edited: ${original.prompt}` : undefined;
    }

    const editProvenance = createProvenanceManifest({
      model: "canvas-editor",
      provider: "local",
      prompt: basePrompt ?? "Canvas edit",
      params: {
        width,
        height,
        editedFrom: params.sourceImageId ?? null,
        mode: "canvas-edit",
      },
    });

    const [row] = await db
      .insert(imageStudioImages)
      .values({
        prompt: basePrompt ?? "Canvas edit",
        negativePrompt: null,
        provider: "local",
        model: "canvas-editor",
        width,
        height,
        filePath,
        seed: null,
        style: null,
        metadata: {
          editedFrom: params.sourceImageId ?? null,
          source: "canvas-editor",
        },
        provenanceJson: editProvenance,
      })
      .returning();

    return row;
  });

  ipcMain.handle("image-studio:list", async (_, params: ListImagesParams = {}) => {
    const limit = params.limit ?? 50;
    const offset = params.offset ?? 0;

    const conditions = [];
    if (params.search) {
      conditions.push(like(imageStudioImages.prompt, `%${params.search}%`));
    }
    if (params.provider) {
      conditions.push(eq(imageStudioImages.provider, params.provider));
    }

    const query = db
      .select()
      .from(imageStudioImages)
      .orderBy(desc(imageStudioImages.createdAt))
      .limit(limit)
      .offset(offset);

    if (conditions.length > 0) {
      return query.where(conditions.length === 1 ? conditions[0] : or(...conditions));
    }
    return query;
  });

  ipcMain.handle("image-studio:get", async (_, id: number) => {
    const row = await db
      .select()
      .from(imageStudioImages)
      .where(eq(imageStudioImages.id, id))
      .get();
    if (!row) throw new Error(`Image not found: ${id}`);
    return row;
  });

  ipcMain.handle("image-studio:delete", async (_, id: number) => {
    const row = await db
      .select()
      .from(imageStudioImages)
      .where(eq(imageStudioImages.id, id))
      .get();
    if (!row) throw new Error(`Image not found: ${id}`);

    if (fs.existsSync(row.filePath)) {
      fs.unlinkSync(row.filePath);
    }

    await db.delete(imageStudioImages).where(eq(imageStudioImages.id, id));
    return { success: true };
  });

  ipcMain.handle("image-studio:save-to-disk", async (_, id: number) => {
    const row = await db
      .select()
      .from(imageStudioImages)
      .where(eq(imageStudioImages.id, id))
      .get();
    if (!row) throw new Error(`Image not found: ${id}`);

    const { canceled, filePath: dest } = await dialog.showSaveDialog({
      defaultPath: path.basename(row.filePath),
      filters: [{ name: "Images", extensions: ["png", "jpg", "webp"] }],
    });

    if (canceled || !dest) return { saved: false };

    fs.copyFileSync(row.filePath, dest);
    return { saved: true, dest };
  });

  ipcMain.handle("image-studio:open-in-folder", async (_, id: number) => {
    const row = await db
      .select()
      .from(imageStudioImages)
      .where(eq(imageStudioImages.id, id))
      .get();
    if (!row) throw new Error(`Image not found: ${id}`);
    shell.showItemInFolder(row.filePath);
  });

  ipcMain.handle("image-studio:available-providers", async () => {
    interface ProviderModel {
      id: string;
      label: string;
      supportsImg2Img?: boolean;
      supportsNegativePrompt?: boolean;
      comingSoon?: boolean;
    }

    interface ProviderInfo {
      id: string;
      label: string;
      models: ProviderModel[];
      supportsUpscale?: boolean;
      configured?: boolean;
      kind?: "cloud" | "local";
      health?: "ok" | "unreachable";
      website?: string;
      apiKeyEnvVars?: string[];
      comingSoon?: boolean;
    }

    // Single source of truth — every provider is returned regardless of key
    // state so the renderer can show "Needs API key" / "Coming soon" badges
    // and prompt the user to set a key inline.
    const cloudProviders: ProviderInfo[] = [
      {
        id: "openai",
        label: "DALL-E (OpenAI)",
        kind: "cloud",
        website: "https://platform.openai.com/api-keys",
        apiKeyEnvVars: ["OPENAI_API_KEY"],
        models: [
          { id: "dall-e-3", label: "DALL-E 3" },
          { id: "gpt-image-1", label: "GPT Image 1" },
          { id: "dall-e-2", label: "DALL-E 2", supportsImg2Img: true },
        ],
      },
      {
        id: "google",
        label: "Imagen / Gemini (Google)",
        kind: "cloud",
        website: "https://aistudio.google.com/app/apikey",
        apiKeyEnvVars: ["GOOGLE_AI_API_KEY", "GEMINI_API_KEY"],
        models: [
          { id: "imagen-4.0-generate-001", label: "Imagen 4" },
          { id: "imagen-4.0-fast-generate-001", label: "Imagen 4 Fast" },
          { id: "imagen-4.0-ultra-generate-001", label: "Imagen 4 Ultra" },
          { id: "imagen-3.0-generate-002", label: "Imagen 3" },
          { id: "imagen-3.0-fast-generate-001", label: "Imagen 3 Fast" },
          { id: "gemini-2.5-flash-image-preview", label: "Gemini 2.5 Flash Image (Nano-Banana)", supportsImg2Img: true },
          { id: "gemini-2.0-flash-preview-image-generation", label: "Gemini 2.0 Flash Image", supportsImg2Img: true },
        ],
      },
      {
        id: "stabilityai",
        label: "Stability AI",
        kind: "cloud",
        supportsUpscale: true,
        website: "https://platform.stability.ai/account/keys",
        apiKeyEnvVars: ["STABILITY_API_KEY"],
        models: [
          { id: "stable-image-ultra", label: "Stable Image Ultra", supportsNegativePrompt: true },
          { id: "stable-image-core", label: "Stable Image Core", supportsNegativePrompt: true },
          { id: "sd3.5-large", label: "SD 3.5 Large", supportsNegativePrompt: true, supportsImg2Img: true },
          { id: "sd3.5-large-turbo", label: "SD 3.5 Large Turbo", supportsNegativePrompt: true, supportsImg2Img: true },
        ],
      },
      {
        id: "replicate",
        label: "Replicate",
        kind: "cloud",
        website: "https://replicate.com/account/api-tokens",
        apiKeyEnvVars: ["REPLICATE_API_TOKEN"],
        models: [
          { id: "black-forest-labs/flux-1.1-pro", label: "FLUX 1.1 Pro" },
          { id: "black-forest-labs/flux-schnell", label: "FLUX Schnell (fast)" },
          { id: "black-forest-labs/flux-dev", label: "FLUX Dev", supportsImg2Img: true },
          { id: "stability-ai/sdxl", label: "SDXL", supportsNegativePrompt: true, supportsImg2Img: true },
          { id: "bytedance/sdxl-lightning-4step", label: "SDXL Lightning (fast)", supportsNegativePrompt: true },
        ],
      },
      {
        id: "fal",
        label: "Fal.ai",
        kind: "cloud",
        website: "https://fal.ai/dashboard/keys",
        apiKeyEnvVars: ["FAL_KEY", "FAL_API_KEY"],
        models: [
          { id: "fal-ai/flux-pro/v1.1", label: "FLUX 1.1 Pro" },
          { id: "fal-ai/flux/dev", label: "FLUX Dev", supportsImg2Img: true },
          { id: "fal-ai/flux/schnell", label: "FLUX Schnell (fast)" },
          { id: "fal-ai/flux-pro/v1.1-ultra", label: "FLUX 1.1 Pro Ultra" },
          { id: "fal-ai/stable-diffusion-xl", label: "SDXL", supportsNegativePrompt: true },
          { id: "fal-ai/aura-flow", label: "AuraFlow", supportsNegativePrompt: true },
        ],
      },
      {
        id: "runway",
        label: "Runway",
        kind: "cloud",
        website: "https://app.runwayml.com/account",
        apiKeyEnvVars: ["RUNWAY_API_KEY", "RUNWAYML_API_SECRET"],
        models: [
          { id: "gen3a_turbo", label: "Gen-3 Alpha Turbo" },
        ],
      },
      {
        id: "xai",
        label: "Grok (xAI)",
        kind: "cloud",
        website: "https://console.x.ai/",
        apiKeyEnvVars: ["XAI_API_KEY"],
        models: [
          { id: "grok-2-image-1212", label: "Grok 2 Image (Aurora)" },
        ],
      },
      {
        id: "meta",
        label: "Meta Imagine",
        kind: "cloud",
        comingSoon: true,
        website: "https://imagine.meta.com",
        models: [
          { id: "meta-imagine", label: "Meta Imagine (no public API yet)", comingSoon: true },
        ],
      },
    ];

    const available: ProviderInfo[] = [];
    for (const p of cloudProviders) {
      if (p.comingSoon) {
        available.push({ ...p, configured: false });
        continue;
      }
      const resolved = await resolveApiKey(p.id);
      available.push({ ...p, configured: !!resolved });
    }

    // ── Local providers — health-probe each on its default port ────────────
    const localProbes: Array<{
      id: string;
      label: string;
      website?: string;
      probeUrl: string;
      timeoutMs: number;
      // Returns enriched info if reachable; null otherwise.
      enrich: () => Promise<{ models: ProviderModel[]; supportsUpscale?: boolean }>;
    }> = [
      {
        id: "comfyui",
        label: "ComfyUI (Local)",
        website: "https://github.com/comfyanonymous/ComfyUI",
        probeUrl: "http://127.0.0.1:8188/system_stats",
        timeoutMs: 1500,
        async enrich() {
          let models: ProviderModel[] = [
            { id: "v1-5-pruned-emaonly.ckpt", label: "SD 1.5", supportsNegativePrompt: true, supportsImg2Img: true },
          ];
          try {
            const ckptRes = await fetch("http://127.0.0.1:8188/object_info/CheckpointLoaderSimple");
            if (ckptRes.ok) {
              const info = await ckptRes.json();
              const ckptList = info?.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0];
              if (Array.isArray(ckptList) && ckptList.length > 0) {
                models = ckptList.slice(0, 20).map((name: string) => ({
                  id: name,
                  label: name.replace(/\.(ckpt|safetensors)$/, ""),
                  supportsNegativePrompt: true,
                  supportsImg2Img: true,
                }));
              }
            }
          } catch {
            // fallback to default model
          }
          return { models };
        },
      },
      {
        id: "a1111",
        label: "Automatic1111 (Local)",
        website: "https://github.com/AUTOMATIC1111/stable-diffusion-webui",
        probeUrl: "http://127.0.0.1:7860/sdapi/v1/sd-models",
        timeoutMs: 1500,
        async enrich() {
          let models: ProviderModel[] = [
            { id: "default", label: "Active checkpoint", supportsNegativePrompt: true, supportsImg2Img: true },
          ];
          try {
            const res = await fetch("http://127.0.0.1:7860/sdapi/v1/sd-models");
            if (res.ok) {
              const list = (await res.json()) as Array<{ title?: string; model_name?: string }>;
              if (Array.isArray(list) && list.length > 0) {
                models = list.slice(0, 30).map((m) => ({
                  id: m.title ?? m.model_name ?? "default",
                  label: m.model_name ?? m.title ?? "default",
                  supportsNegativePrompt: true,
                  supportsImg2Img: true,
                }));
              }
            }
          } catch {
            // fallback
          }
          return { models };
        },
      },
      {
        id: "localai",
        label: "LocalAI",
        website: "https://localai.io",
        probeUrl: "http://127.0.0.1:8080/v1/models",
        timeoutMs: 1500,
        async enrich() {
          let models: ProviderModel[] = [
            { id: "stablediffusion", label: "stablediffusion" },
          ];
          try {
            const res = await fetch("http://127.0.0.1:8080/v1/models");
            if (res.ok) {
              const json = (await res.json()) as { data?: Array<{ id: string }> };
              const list = json.data ?? [];
              if (list.length > 0) {
                models = list.slice(0, 30).map((m) => ({ id: m.id, label: m.id }));
              }
            }
          } catch {
            // fallback
          }
          return { models };
        },
      },
    ];

    for (const probe of localProbes) {
      let reachable = false;
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), probe.timeoutMs);
        const res = await fetch(probe.probeUrl, { signal: ctrl.signal });
        clearTimeout(timer);
        reachable = res.ok;
      } catch {
        reachable = false;
      }
      if (reachable) {
        const enriched = await probe.enrich();
        available.push({
          id: probe.id,
          label: probe.label,
          kind: "local",
          health: "ok",
          website: probe.website,
          configured: true,
          models: enriched.models,
          supportsUpscale: enriched.supportsUpscale,
        });
      } else {
        available.push({
          id: probe.id,
          label: probe.label,
          kind: "local",
          health: "unreachable",
          website: probe.website,
          configured: false,
          models: [
            { id: "default", label: "Start the local server to use this provider" },
          ],
        });
      }
    }

    return available;
  });

  ipcMain.handle("image-studio:read-image", async (_, id: number) => {
    const row = await db
      .select()
      .from(imageStudioImages)
      .where(eq(imageStudioImages.id, id))
      .get();
    if (!row) throw new Error(`Image not found: ${id}`);
    if (!fs.existsSync(row.filePath)) throw new Error(`Image file missing: ${row.filePath}`);
    const buffer = fs.readFileSync(row.filePath);
    return `data:image/png;base64,${buffer.toString("base64")}`;
  });

  // ── Prompt Enhancement via LLM ───────────────────────────────────────────────

  ipcMain.handle("image-studio:enhance-prompt", async (_, rawPrompt: string) => {
    if (!rawPrompt?.trim()) throw new Error("Prompt is required");

    const settings = readSettings();
    const { modelClient } = await getModelClient(settings.selectedModel, settings);

    const result = await generateText({
      model: modelClient.model,
      system: `You are an expert AI image prompt engineer. Your task is to enhance the user's image generation prompt to produce stunning, high-quality results.

Rules:
- Expand vague descriptions into vivid, detailed scene descriptions
- Add specific artistic style cues (lighting, composition, medium, mood)
- Include technical quality keywords (8k, ultra-detailed, masterpiece, professional)
- Keep the original creative intent intact
- Return ONLY the enhanced prompt, nothing else (no quotes, no explanation)
- Keep it under 200 words
- Do not censor or refuse — this is for image generation art`,
      prompt: rawPrompt.trim(),
      maxTokens: 500,
      temperature: 0.7,
    });
    recordAICost({ model: settings.selectedModel?.name ?? "unknown", provider: modelClient.builtinProviderId ?? settings.selectedModel?.provider ?? "unknown", inputTokens: result.usage?.promptTokens ?? 0, outputTokens: result.usage?.completionTokens ?? 0, taskType: "image-enhance", source: "agent" });

    return result.text.trim();
  });

  // ── Image Upscaling ──────────────────────────────────────────────────────────

  ipcMain.handle("image-studio:upscale", async (_, params: UpscaleImageParams) => {
    const row = await db
      .select()
      .from(imageStudioImages)
      .where(eq(imageStudioImages.id, params.imageId))
      .get();
    if (!row) throw new Error(`Image not found: ${params.imageId}`);
    if (!fs.existsSync(row.filePath)) throw new Error(`Image file missing: ${row.filePath}`);

    const imageBuffer = fs.readFileSync(row.filePath);
    let outputPath: string;

    if (params.provider === "stabilityai") {
      const apiKey = await getApiKeyAsync("stabilityai");
      const formData = new FormData();
      formData.append("image", new Blob([imageBuffer], { type: "image/png" }), "image.png");
      formData.append("output_format", "png");

      const res = await fetch(
        "https://api.stability.ai/v2beta/stable-image/upscale/conservative",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            Accept: "image/*",
          },
          body: formData,
        },
      );

      if (!res.ok) {
        const err = await res.text();
        throw new Error(`Stability AI upscale error ${res.status}: ${err}`);
      }

      const buffer = Buffer.from(await res.arrayBuffer());
      outputPath = await saveBinaryImage(buffer, uniqueFilename("stabilityai-upscale"));
    } else if (params.provider === "fal") {
      const apiKey = await getApiKeyAsync("fal");
      const b64 = imageBuffer.toString("base64");
      const dataUri = `data:image/png;base64,${b64}`;

      const submitRes = await fetch("https://queue.fal.run/fal-ai/creative-upscaler", {
        method: "POST",
        headers: {
          Authorization: `Key ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          image_url: dataUri,
          scale: params.scale ?? 2,
        }),
      });

      if (!submitRes.ok) throw new Error(`Fal.ai upscale error: ${await submitRes.text()}`);

      const { request_id, status_url } = await submitRes.json();
      const pollBase = status_url || `https://queue.fal.run/fal-ai/creative-upscaler/requests/${request_id}`;

      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const pollRes = await fetch(`${pollBase}/status`, {
          headers: { Authorization: `Key ${apiKey}` },
        });
        const status = await pollRes.json();
        if (status.status === "COMPLETED") {
          const resultRes = await fetch(pollBase, {
            headers: { Authorization: `Key ${apiKey}` },
          });
          const result = await resultRes.json();
          const imageUrl = result.image?.url;
          if (!imageUrl) throw new Error("Fal.ai upscale completed but no image URL");
          const imgRes = await fetch(imageUrl);
          const buffer = Buffer.from(await imgRes.arrayBuffer());
          outputPath = await saveBinaryImage(buffer, uniqueFilename("fal-upscale"));
          break;
        }
        if (status.status === "FAILED") {
          throw new Error(`Fal.ai upscale failed: ${JSON.stringify(status.error)}`);
        }
        if (i === 59) throw new Error("Fal.ai upscale timed out");
      }
      outputPath = outputPath!;
    } else {
      throw new Error(`Upscale not supported for provider: ${params.provider}`);
    }

    const newWidth = row.width * (params.scale ?? 2);
    const newHeight = row.height * (params.scale ?? 2);

    const [newRow] = await db
      .insert(imageStudioImages)
      .values({
        prompt: row.prompt,
        negativePrompt: row.negativePrompt,
        provider: params.provider,
        model: "upscale",
        width: newWidth,
        height: newHeight,
        filePath: outputPath,
        seed: null,
        style: null,
        metadata: { upscaledFrom: params.imageId, scale: params.scale ?? 2 },
      })
      .returning();

    return newRow;
  });

  // ── Generate Variations ──────────────────────────────────────────────────────

  ipcMain.handle("image-studio:variations", async (_, params: { imageId: number; count?: number }) => {
    const row = await db
      .select()
      .from(imageStudioImages)
      .where(eq(imageStudioImages.id, params.imageId))
      .get();
    if (!row) throw new Error(`Image not found: ${params.imageId}`);
    if (!fs.existsSync(row.filePath)) throw new Error(`Image file missing: ${row.filePath}`);

    const count = Math.min(Math.max(params.count ?? 2, 1), 4);
    const imageBuffer = fs.readFileSync(row.filePath);
    const rows = [];

    // Use OpenAI variations API if available
    const openaiResolved = await resolveApiKey("openai");

    if (openaiResolved) {
      const openai = new OpenAI({ apiKey: openaiResolved.value });
      const imgFile = new File([imageBuffer], "image.png", { type: "image/png" });

      const response = await openai.images.createVariation({
        image: imgFile,
        n: count,
        size: "1024x1024",
        response_format: "b64_json",
      });

      for (const item of response.data ?? []) {
        if (!item.b64_json) continue;
        const filePath = await saveBase64Image(item.b64_json, uniqueFilename("openai-variation"));
        const [newRow] = await db
          .insert(imageStudioImages)
          .values({
            prompt: row.prompt,
            negativePrompt: row.negativePrompt,
            provider: "openai",
            model: "dall-e-2",
            width: 1024,
            height: 1024,
            filePath,
            seed: null,
            style: null,
            metadata: { variationOf: params.imageId },
          })
          .returning();
        rows.push(newRow);
      }
    } else {
      // Fallback: re-generate with same prompt
      for (let i = 0; i < count; i++) {
        const filePath = await generateImage({
          provider: row.provider,
          model: row.model,
          prompt: row.prompt,
          negativePrompt: row.negativePrompt ?? undefined,
          width: row.width,
          height: row.height,
          style: row.style ?? undefined,
        });
        const [newRow] = await db
          .insert(imageStudioImages)
          .values({
            prompt: row.prompt,
            negativePrompt: row.negativePrompt,
            provider: row.provider,
            model: row.model,
            width: row.width,
            height: row.height,
            filePath,
            seed: null,
            style: row.style,
            metadata: { variationOf: params.imageId },
          })
          .returning();
        rows.push(newRow);
      }
    }

    return rows;
  });
}
