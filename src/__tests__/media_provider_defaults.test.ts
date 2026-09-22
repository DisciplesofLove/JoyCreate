/**
 * `image-studio:generate` and `video-studio:generate` both throw "Provider is
 * required" on their first line, and both record `model` in the provenance
 * manifest of every asset they produce. Three callers each got that wrong in a
 * different way:
 *
 *   - the MCP tools never exposed `provider`, so every agent call failed;
 *   - the autonomous action catalog — what a Discord or Telegram message
 *     actually plans against — marks it optional and advertised the values as
 *     "openai, google, stability, local", two of which the handler rejects as
 *     "Unsupported image provider";
 *   - nothing supplied `model` at all.
 *
 * These tests pin the resolution, because the failure is invisible from a chat
 * window: you ask for a picture and the bot says it could not do it.
 */

import { describe, expect, it } from "vitest";

import {
  IMAGE_PROVIDERS,
  VIDEO_PROVIDERS,
  defaultModelFor,
  normaliseProvider,
  pickUsableProvider,
} from "@/lib/media/provider_defaults";

describe("normalising a provider name", () => {
  it("accepts the names the handler dispatches on", () => {
    for (const p of IMAGE_PROVIDERS) {
      expect(normaliseProvider(p, "image")).toBe(p);
    }
  });

  it("maps the names the catalog used to advertise", () => {
    // The catalog told planners to say "stability" and "local". Rejecting those
    // for a spelling difference is a self-inflicted failure.
    expect(normaliseProvider("stability", "image")).toBe("stabilityai");
    expect(normaliseProvider("local", "image")).toBe("localai");
  });

  it("maps names a person or model would reasonably use", () => {
    expect(normaliseProvider("dall-e", "image")).toBe("openai");
    expect(normaliseProvider("gemini", "image")).toBe("google");
    expect(normaliseProvider("automatic1111", "image")).toBe("a1111");
    expect(normaliseProvider("grok", "image")).toBe("xai");
  });

  it("is case- and whitespace-insensitive", () => {
    expect(normaliseProvider("  StabilityAI ", "image")).toBe("stabilityai");
  });

  it("rejects a provider the handler cannot dispatch", () => {
    expect(normaliseProvider("midjourney", "image")).toBeNull();
  });

  it("does not accept an image-only provider for video", () => {
    // comfyui renders images here; asking the video handler for it would hit
    // its default branch and fail.
    expect(normaliseProvider("comfyui", "video")).toBeNull();
    expect(normaliseProvider("luma", "video")).toBe("luma");
  });

  it("returns null for nothing at all", () => {
    expect(normaliseProvider(undefined, "image")).toBeNull();
    expect(normaliseProvider("", "image")).toBeNull();
  });
});

describe("choosing a provider that will work", () => {
  const available = [
    { id: "openai", configured: false },
    { id: "stabilityai", configured: true, health: "ok" as const },
    { id: "localai", configured: true, health: "ok" as const },
  ];

  it("honours an explicit choice", () => {
    expect(pickUsableProvider("localai", available, "image")).toBe("localai");
  });

  it("honours an explicit choice by alias", () => {
    expect(pickUsableProvider("stability", available, "image")).toBe("stabilityai");
  });

  it("falls back to the first configured provider", () => {
    // openai is listed first but is not configured, so it must be skipped —
    // picking it would fail with a missing-API-key error the user never chose.
    expect(pickUsableProvider(undefined, available, "image")).toBe("stabilityai");
  });

  it("skips a provider that is unreachable", () => {
    const withDeadLocal = [
      { id: "localai", configured: true, health: "unreachable" as const },
      { id: "openai", configured: true, health: "ok" as const },
    ];
    expect(pickUsableProvider(undefined, withDeadLocal, "image")).toBe("openai");
  });

  it("skips a provider marked coming soon", () => {
    const soon = [
      { id: "xai", configured: true, comingSoon: true },
      { id: "fal", configured: true },
    ];
    expect(pickUsableProvider(undefined, soon, "image")).toBe("fal");
  });

  it("returns null when nothing is usable, so the caller can say so", () => {
    // The alternative is letting the handler fail with a message about a
    // provider the user never picked.
    expect(pickUsableProvider(undefined, [{ id: "openai", configured: false }], "image"))
      .toBeNull();
    expect(pickUsableProvider(undefined, [], "image")).toBeNull();
    expect(pickUsableProvider(undefined, undefined, "image")).toBeNull();
  });

  it("ignores availability entries that are not real providers", () => {
    expect(
      pickUsableProvider(undefined, [{ id: "midjourney", configured: true }], "image"),
    ).toBeNull();
  });

  it("prefers an explicit choice even when it is not in the availability list", () => {
    // The list is advisory; a user naming a provider knows something we do not.
    expect(pickUsableProvider("runway", available, "image")).toBe("runway");
  });
});

describe("default models", () => {
  it("names a model for every cloud image provider", () => {
    for (const p of IMAGE_PROVIDERS) {
      const m = defaultModelFor(p, "image");
      // Local backends serve whatever checkpoint is loaded, so an empty string
      // is correct for them and naming one that is absent would fail.
      if (["comfyui", "a1111", "localai"].includes(p)) {
        expect(m).toBe("");
      } else {
        expect(m.length).toBeGreaterThan(0);
      }
    }
  });

  it("names a model for every video provider", () => {
    for (const p of VIDEO_PROVIDERS) {
      expect(defaultModelFor(p, "video").length).toBeGreaterThan(0);
    }
  });

  it("returns an empty string for an unknown provider rather than throwing", () => {
    expect(defaultModelFor("nope", "image")).toBe("");
  });
});
