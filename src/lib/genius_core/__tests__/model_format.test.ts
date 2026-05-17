/**
 * Genius Core base-model catalogue integrity tests.
 *
 * Phase 0 keeps the catalogue static, but lots of subsystems depend on its
 * invariants (ids unique, hfRepo non-empty, VRAM budget heuristics, etc.),
 * so we lock them in early.
 */

import { describe, expect, it } from "vitest";

import { GENIUS_CORE_BASE_MODELS, findBaseModel } from "../model_format";

describe("Genius Core base model catalogue", () => {
  it("ships at least one curated entry", () => {
    expect(GENIUS_CORE_BASE_MODELS.length).toBeGreaterThan(0);
  });

  it("has unique, non-empty ids", () => {
    const ids = GENIUS_CORE_BASE_MODELS.map((m) => m.id);
    expect(ids.every((id) => typeof id === "string" && id.length > 0)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("declares a non-empty hfRepo for every entry", () => {
    for (const m of GENIUS_CORE_BASE_MODELS) {
      expect(m.hfRepo).toMatch(/.+\/.+/);
    }
  });

  it("declares a positive context window and byte budget", () => {
    for (const m of GENIUS_CORE_BASE_MODELS) {
      expect(m.contextWindow).toBeGreaterThan(0);
      expect(m.approxBytes).toBeGreaterThan(0);
    }
  });

  it("lists at least one supported execution provider including 'cpu' or 'auto'", () => {
    for (const m of GENIUS_CORE_BASE_MODELS) {
      expect(m.supportedProviders.length).toBeGreaterThan(0);
      expect(m.supportedProviders.some((p) => p === "cpu" || p === "auto")).toBe(true);
    }
  });

  it("findBaseModel() returns the entry for a known id", () => {
    const first = GENIUS_CORE_BASE_MODELS[0];
    expect(findBaseModel(first.id)).toBe(first);
  });

  it("findBaseModel() returns undefined for an unknown id", () => {
    expect(findBaseModel("nope-does-not-exist")).toBeUndefined();
  });
});
