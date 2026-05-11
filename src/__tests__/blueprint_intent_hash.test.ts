/**
 * Whitehat intent hash — determinism + tamper detection.
 * Pure: no DB.
 */

import { describe, it, expect } from "vitest";
import {
  canonicalManifest,
  computeIntentHash,
  assertIntentHash,
} from "@/lib/blueprint/intent_hash";
import type { ResolvedSkill } from "@/lib/blueprint/skill_resolver";
import { BlueprintIntegrityError } from "@/types/blueprint_types";

const builtin: ResolvedSkill = {
  kind: "builtin",
  adapter: {
    name: "celestia-anchor",
    channel: "celestia:blob:submit",
    description: "Anchor a content hash to the Celestia DA layer.",
  },
};

function fakeSkill(overrides: Record<string, unknown> = {}): ResolvedSkill {
  return {
    kind: "skill_engine",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    skill: {
      id: 42,
      name: "summarize",
      description: "x",
      category: "general",
      version: "1.0.0",
      type: "function",
      implementationType: "javascript",
      implementationCode: "return input.length;",
      inputSchema: { type: "string" },
      outputSchema: { type: "number" },
      enabled: true,
      ...overrides,
    } as any,
  };
}

describe("computeIntentHash", () => {
  it("is deterministic across calls", () => {
    const h1 = computeIntentHash(builtin);
    const h2 = computeIntentHash(builtin);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when skill code changes", () => {
    const h1 = computeIntentHash(fakeSkill());
    const h2 = computeIntentHash(fakeSkill({ implementationCode: "return 0;" }));
    expect(h1).not.toBe(h2);
  });

  it("changes when skill version changes", () => {
    const h1 = computeIntentHash(fakeSkill());
    const h2 = computeIntentHash(fakeSkill({ version: "2.0.0" }));
    expect(h1).not.toBe(h2);
  });

  it("is insensitive to manifest key order (canonicalization)", () => {
    const m1 = canonicalManifest(fakeSkill());
    const m2 = canonicalManifest(fakeSkill());
    // sorted-key serialization MUST match exactly
    expect(JSON.stringify(m1)).toBe(JSON.stringify(m2));
  });

  it("differs for skill_engine vs builtin even with same name", () => {
    const a = computeIntentHash(builtin);
    const b = computeIntentHash(fakeSkill({ name: "celestia-anchor" }));
    expect(a).not.toBe(b);
  });
});

describe("assertIntentHash", () => {
  it("passes when hash matches", () => {
    const h = computeIntentHash(builtin);
    expect(() => assertIntentHash("node-1", h, builtin)).not.toThrow();
  });

  it("throws BlueprintIntegrityError when hash does not match", () => {
    expect(() =>
      assertIntentHash("node-1", "0".repeat(64), builtin),
    ).toThrow(BlueprintIntegrityError);
  });

  it("error carries node id and both hashes", () => {
    try {
      assertIntentHash("scrape", "0".repeat(64), builtin);
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(BlueprintIntegrityError);
      const e = err as BlueprintIntegrityError;
      expect(e.nodeId).toBe("scrape");
      expect(e.expected).toBe("0".repeat(64));
      expect(e.actual).toBe(computeIntentHash(builtin));
    }
  });
});
