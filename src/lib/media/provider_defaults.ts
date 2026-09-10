/**
 * Provider names and default models for image and video generation.
 *
 * `image-studio:generate` and `video-studio:generate` both require `provider`
 * and `model` — they throw "Provider is required" before doing anything else.
 * Every caller therefore has to resolve those two values, and three callers
 * were each getting it wrong in a different way:
 *
 *   - the MCP tools did not expose `provider` at all, so every agent call
 *     failed on the first line of the handler;
 *   - the autonomous action catalog marks `provider` optional and documents the
 *     values as "openai, google, stability, local" — but the handler dispatches
 *     on `stabilityai` and `localai`, so two of the four names it advertises
 *     are rejected as "Unsupported image provider";
 *   - neither supplied `model`, which the handler records in the provenance
 *     manifest for every generated asset.
 *
 * This is the one place those facts live. A leaf module with no imports, so
 * anything that needs to describe providers can read it cheaply.
 */

/** Providers `image-studio:generate` dispatches on. */
export const IMAGE_PROVIDERS = [
  "openai",
  "google",
  "stabilityai",
  "replicate",
  "fal",
  "runway",
  "comfyui",
  "xai",
  "a1111",
  "localai",
] as const;

/** Providers `video-studio:generate` dispatches on. */
export const VIDEO_PROVIDERS = [
  "runway",
  "fal",
  "replicate",
  "luma",
  "stabilityai",
  "google",
  "openai",
] as const;

export type ImageProvider = (typeof IMAGE_PROVIDERS)[number];
export type VideoProvider = (typeof VIDEO_PROVIDERS)[number];

/**
 * Names people and models reasonably say, mapped to what the handler accepts.
 *
 * A planner told the options are "stability" and "local" will use those words;
 * rejecting them for a spelling difference is a self-inflicted failure.
 */
const ALIASES: Record<string, string> = {
  stability: "stabilityai",
  "stable-diffusion": "stabilityai",
  stabilityai: "stabilityai",
  local: "localai",
  localai: "localai",
  automatic1111: "a1111",
  auto1111: "a1111",
  a1111: "a1111",
  comfy: "comfyui",
  comfyui: "comfyui",
  grok: "xai",
  xai: "xai",
  "x-ai": "xai",
  openai: "openai",
  dalle: "openai",
  "dall-e": "openai",
  google: "google",
  gemini: "google",
  imagen: "google",
  replicate: "replicate",
  fal: "fal",
  runway: "runway",
  luma: "luma",
};

/** Normalise a user- or model-supplied provider name. Returns null if unknown. */
export function normaliseProvider(
  raw: string | undefined,
  kind: "image" | "video",
): string | null {
  if (!raw) return null;
  const key = raw.trim().toLowerCase();
  const mapped = ALIASES[key] ?? key;
  const allowed: readonly string[] =
    kind === "image" ? IMAGE_PROVIDERS : VIDEO_PROVIDERS;
  return allowed.includes(mapped) ? mapped : null;
}

/**
 * A sensible model per provider, since the handler requires one.
 *
 * An empty string is deliberate for the local backends: they serve whatever
 * checkpoint is loaded, and naming one that is not present fails.
 */
export const DEFAULT_IMAGE_MODELS: Record<string, string> = {
  openai: "dall-e-3",
  google: "imagen-3.0-generate-002",
  stabilityai: "stable-diffusion-3.5-large",
  replicate: "black-forest-labs/flux-schnell",
  fal: "fal-ai/flux/schnell",
  runway: "gen3a_turbo",
  xai: "grok-2-image",
  comfyui: "",
  a1111: "",
  localai: "",
};

export const DEFAULT_VIDEO_MODELS: Record<string, string> = {
  runway: "gen3a_turbo",
  fal: "fal-ai/ltx-video",
  replicate: "lightricks/ltx-video",
  luma: "ray-2",
  stabilityai: "stable-video-diffusion",
  google: "veo-2.0-generate-001",
  openai: "sora-2",
};

export function defaultModelFor(
  provider: string,
  kind: "image" | "video",
): string {
  const table = kind === "image" ? DEFAULT_IMAGE_MODELS : DEFAULT_VIDEO_MODELS;
  return table[provider] ?? "";
}

/** Shape returned by `image-studio:available-providers`. */
export interface ProviderAvailability {
  id: string;
  label?: string;
  configured?: boolean;
  health?: "ok" | "unreachable";
  comingSoon?: boolean;
}

/**
 * Pick a provider that will actually work.
 *
 * Prefers an explicit choice, then the first provider that is configured and
 * healthy. Returns null when nothing is usable, so the caller can say "no image
 * provider is configured" instead of letting the handler fail with a message
 * about a provider the user never chose.
 */
export function pickUsableProvider(
  requested: string | undefined,
  available: ProviderAvailability[] | undefined,
  kind: "image" | "video",
): string | null {
  const explicit = normaliseProvider(requested, kind);
  if (explicit) return explicit;

  const allowed: readonly string[] =
    kind === "image" ? IMAGE_PROVIDERS : VIDEO_PROVIDERS;

  const usable = (available ?? []).filter(
    (p) =>
      !p.comingSoon &&
      p.configured !== false &&
      p.health !== "unreachable" &&
      allowed.includes(p.id),
  );

  return usable[0]?.id ?? null;
}
