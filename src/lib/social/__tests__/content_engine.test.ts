/**
 * Content engine unit tests.
 *
 * The LLM-backed helpers are exercised through the `ContentEngineDeps.complete`
 * override so no real model is invoked. `planCampaignCalendar` is pure and is
 * tested directly. Electron-bound imports are mocked so the module loads under
 * the happy-dom/node test environment.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@/ipc/utils/get_model_client", () => ({
  getModelClient: vi.fn(async () => ({ modelClient: { model: {} } })),
}));
vi.mock("@/main/settings", () => ({
  readSettings: vi.fn(() => ({})),
}));
vi.mock("ai", () => ({
  generateText: vi.fn(async () => ({ text: "" })),
}));

import type { SocialCampaignCadence } from "@/db/social_schema";
import {
  extractJson,
  generatePostDrafts,
  parseNaturalLanguageSetup,
  planCampaignCalendar,
  suggestReply,
} from "../content_engine";

describe("extractJson", () => {
  it("parses a fenced JSON block", () => {
    const out = extractJson<{ a: number }>("noise\n```json\n{\"a\": 1}\n```");
    expect(out.a).toBe(1);
  });

  it("parses a bare array embedded in prose", () => {
    const out = extractJson<number[]>("Here you go: [1, 2, 3] done");
    expect(out).toEqual([1, 2, 3]);
  });

  it("throws when there is no JSON", () => {
    expect(() => extractJson("just words")).toThrow();
  });
});

describe("generatePostDrafts", () => {
  it("maps model output to drafts and strips leading # from hashtags", async () => {
    const complete = vi.fn(async () =>
      JSON.stringify([
        { text: "Hello world", hashtags: ["#ai", "social"], imagePrompt: "a robot" },
        { text: "  ", hashtags: [] },
      ]),
    );
    const drafts = await generatePostDrafts(
      { topics: ["ai"], count: 3 },
      { complete },
    );
    expect(drafts).toHaveLength(1);
    expect(drafts[0].text).toBe("Hello world");
    expect(drafts[0].hashtags).toEqual(["ai", "social"]);
    expect(drafts[0].imagePrompt).toBe("a robot");
  });

  it("rejects an empty topic list", async () => {
    await expect(
      generatePostDrafts({ topics: ["   "] }, { complete: vi.fn() }),
    ).rejects.toThrow(/topic/i);
  });
});

describe("parseNaturalLanguageSetup", () => {
  it("normalizes providers and falls back on defaults", async () => {
    const complete = vi.fn(async () =>
      JSON.stringify({
        name: "Launch buzz",
        topics: ["product launch", "  "],
        suggestedProviders: ["Reddit", "myspace"],
        cadence: { frequency: "daily", slots: ["08:00", "bad"] },
        autoPublish: true,
      }),
    );
    const setup = await parseNaturalLanguageSetup(
      "promote our launch daily",
      { availableProviders: ["reddit", "twitter"] },
      { complete },
    );
    expect(setup.name).toBe("Launch buzz");
    expect(setup.topics).toEqual(["product launch"]);
    expect(setup.suggestedProviders).toEqual(["reddit"]);
    expect(setup.cadence.frequency).toBe("daily");
    expect(setup.cadence.slots).toEqual(["08:00"]);
    expect(setup.autoPublish).toBe(true);
    expect(setup.autoGenerate).toBe(false);
  });

  it("requires an instruction", async () => {
    await expect(
      parseNaturalLanguageSetup("  ", undefined, { complete: vi.fn() }),
    ).rejects.toThrow();
  });
});

describe("suggestReply", () => {
  it("trims surrounding quotes from the model output", async () => {
    const complete = vi.fn(async () => '"Thanks for reaching out!"');
    const reply = await suggestReply(
      { engagementText: "Love this" },
      { complete },
    );
    expect(reply).toBe("Thanks for reaching out!");
  });

  it("rejects empty engagement text", async () => {
    await expect(
      suggestReply({ engagementText: "" }, { complete: vi.fn() }),
    ).rejects.toThrow();
  });
});

describe("planCampaignCalendar", () => {
  const base = new Date(2024, 0, 1, 6, 0, 0, 0).getTime(); // Mon Jan 1 2024 06:00

  it("produces the requested number of future slots", () => {
    const cadence: SocialCampaignCadence = {
      frequency: "daily",
      slots: ["09:00"],
    };
    const slots = planCampaignCalendar({
      cadence,
      fromMs: base,
      count: 3,
      topics: ["a", "b"],
    });
    expect(slots).toHaveLength(3);
    // strictly increasing and in the future
    expect(slots[0].scheduledFor).toBeGreaterThan(base);
    expect(slots[1].scheduledFor).toBeGreaterThan(slots[0].scheduledFor);
    // round-robin topic assignment
    expect(slots.map((s) => s.topic)).toEqual(["a", "b", "a"]);
  });

  it("only schedules weekdays for the weekdays frequency", () => {
    const cadence: SocialCampaignCadence = {
      frequency: "weekdays",
      slots: ["09:00"],
    };
    const slots = planCampaignCalendar({
      cadence,
      fromMs: base,
      count: 10,
      topics: ["x"],
    });
    for (const slot of slots) {
      const dow = new Date(slot.scheduledFor).getDay();
      expect(dow).toBeGreaterThanOrEqual(1);
      expect(dow).toBeLessThanOrEqual(5);
    }
  });

  it("respects daysOfWeek for the weekly frequency", () => {
    const cadence: SocialCampaignCadence = {
      frequency: "weekly",
      slots: ["10:00"],
      daysOfWeek: [3], // Wednesday only
    };
    const slots = planCampaignCalendar({
      cadence,
      fromMs: base,
      count: 4,
      topics: ["x"],
    });
    expect(slots).toHaveLength(4);
    for (const slot of slots) {
      expect(new Date(slot.scheduledFor).getDay()).toBe(3);
    }
  });
});
