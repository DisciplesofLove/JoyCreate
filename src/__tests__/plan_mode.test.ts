/**
 * Plan mode must change nothing until the user approves, and each decision
 * must produce the right follow-up turn. A regression here either lets a plan
 * silently edit files, or makes Approve/Revise look like they did nothing.
 */

import { describe, expect, it } from "vitest";

import {
  buildPlanRespondPrompt,
  extractPlanProposal,
  isReadOnlyChatMode,
} from "@/shared/plan_mode";

describe("read-only chat modes", () => {
  it("treats Plan like Ask — no writes, no auto-fix", () => {
    expect(isReadOnlyChatMode("ask")).toBe(true);
    expect(isReadOnlyChatMode("plan")).toBe(true);
  });

  it("lets every building mode write", () => {
    for (const mode of ["build", "agent", "autonomous", "mcp", "local-agent"]) {
      expect(isReadOnlyChatMode(mode)).toBe(false);
    }
  });

  it("treats a missing mode as writable, matching the build default", () => {
    expect(isReadOnlyChatMode(undefined)).toBe(false);
    expect(isReadOnlyChatMode(null)).toBe(false);
  });
});

describe("finding a plan in a message", () => {
  it("extracts the title and body", () => {
    const content = `Here is my plan.\n<joy-plan-proposal title="Add dark mode">\n**Goal** — toggle\n1. Add theme\n</joy-plan-proposal>\nThoughts?`;
    expect(extractPlanProposal(content)).toEqual({
      title: "Add dark mode",
      body: "**Goal** — toggle\n1. Add theme",
    });
  });

  it("falls back to a generic title", () => {
    expect(extractPlanProposal("<joy-plan-proposal>1. Do it</joy-plan-proposal>")?.title).toBe("Plan");
  });

  it("ignores a plan that is still streaming (no closing tag)", () => {
    // Showing Approve on half a plan would let the user approve steps they
    // have not seen yet.
    expect(extractPlanProposal(`<joy-plan-proposal title="x">1. half`)).toBeNull();
  });

  it("ignores an empty plan and messages without one", () => {
    expect(extractPlanProposal(`<joy-plan-proposal title="x">  </joy-plan-proposal>`)).toBeNull();
    expect(extractPlanProposal("just chatting")).toBeNull();
    expect(extractPlanProposal(null)).toBeNull();
  });
});

describe("the follow-up turn for each decision", () => {
  it("approve runs the plan in Build mode for one turn", () => {
    const r = buildPlanRespondPrompt({ action: "approve", planTitle: "Add dark mode" });
    expect(r.chatModeOverride).toBe("build");
    expect(r.prompt).toMatch(/approve the plan "Add dark mode"/);
  });

  it("revise stays in Plan mode and carries the feedback", () => {
    const r = buildPlanRespondPrompt({ action: "revise", planTitle: "P", feedback: "use CSS vars" });
    expect(r.chatModeOverride).toBeNull();
    expect(r.prompt).toMatch(/use CSS vars/);
  });

  it("refuses a revise without feedback rather than regenerating the same plan", () => {
    expect(() => buildPlanRespondPrompt({ action: "revise", planTitle: "P", feedback: "  " })).toThrow(
      /needs feedback/,
    );
  });

  it("reject tells the model not to implement, with or without a reason", () => {
    const withReason = buildPlanRespondPrompt({ action: "reject", planTitle: "P", feedback: "too big" });
    expect(withReason.prompt).toMatch(/do not implement it\. Reason: too big/);
    expect(withReason.chatModeOverride).toBeNull();

    const bare = buildPlanRespondPrompt({ action: "reject", planTitle: "P" });
    expect(bare.prompt).toMatch(/do not implement it/);
  });
});
