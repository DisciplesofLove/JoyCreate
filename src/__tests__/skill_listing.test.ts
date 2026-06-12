import { describe, it, expect } from "vitest";

import { skillRowToAuthorInput, type SkillRow } from "@/lib/onchain/skill_listing";

function row(overrides: Partial<SkillRow>): SkillRow {
  return {
    id: 1,
    name: "Test Skill",
    description: "does a thing",
    category: "text_generation",
    type: "custom",
    implementationType: "prompt",
    implementationCode: null,
    triggerPatterns: [],
    inputSchema: null,
    outputSchema: null,
    examples: [],
    tags: [],
    version: "1.0.0",
    authorId: null,
    publishStatus: "local",
    marketplaceId: null,
    price: 0,
    currency: "USD",
    downloads: 0,
    rating: 0,
    enabled: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    hyperDrivePath: null,
    hyperDiscoveryKeyHex: null,
    ...overrides,
  } as SkillRow;
}

describe("skillRowToAuthorInput", () => {
  it("maps a prompt skill to a prompt-agent using its implementation code", () => {
    const input = skillRowToAuthorInput(
      row({ implementationType: "prompt", implementationCode: "You are helpful." }),
      { modelId: "llama3", promptTemplate: "{{input}}" },
    );
    expect(input).toEqual({
      kind: "prompt-agent",
      modelId: "llama3",
      systemPrompt: "You are helpful.",
      promptTemplate: "{{input}}",
      maxTokens: undefined,
      temperature: undefined,
    });
  });

  it("falls back to the description when a prompt skill has no implementation code", () => {
    const input = skillRowToAuthorInput(
      row({ implementationType: "prompt", implementationCode: null, description: "summarise text" }),
      { modelId: "llama3" },
    );
    expect(input).toMatchObject({ kind: "prompt-agent", systemPrompt: "summarise text" });
  });

  it("throws when a prompt skill is listed without a modelId", () => {
    expect(() =>
      skillRowToAuthorInput(row({ implementationType: "prompt", implementationCode: "hi" }), {}),
    ).toThrow(/needs a modelId/);
  });

  it("maps a tool skill to a tool-agent with the supplied allow-list", () => {
    const input = skillRowToAuthorInput(
      row({ implementationType: "tool", implementationCode: "use tools" }),
      { modelId: "llama3", tools: ["mcp__server__do"], maxSteps: 4 },
    );
    expect(input).toEqual({
      kind: "tool-agent",
      modelId: "llama3",
      systemPrompt: "use tools",
      tools: ["mcp__server__do"],
      maxSteps: 4,
      promptTemplate: undefined,
      maxTokens: undefined,
      temperature: undefined,
    });
  });

  it("throws when a tool skill has an empty tool allow-list", () => {
    expect(() =>
      skillRowToAuthorInput(row({ implementationType: "tool" }), { modelId: "llama3", tools: [] }),
    ).toThrow(/non-empty MCP tool allow-list/);
  });

  it("maps a function skill to a code-agent", () => {
    const input = skillRowToAuthorInput(
      row({ implementationType: "function", implementationCode: "return input.length;" }),
      { allowedModules: ["crypto"], timeoutMs: 1000, maxMemoryMb: 64 },
    );
    expect(input).toEqual({
      kind: "code-agent",
      code: "return input.length;",
      allowedModules: ["crypto"],
      timeoutMs: 1000,
      maxMemoryMb: 64,
    });
  });

  it("throws when a function skill has no implementation code", () => {
    expect(() =>
      skillRowToAuthorInput(row({ implementationType: "function", implementationCode: "  " }), {}),
    ).toThrow(/needs implementation code/);
  });

  it("throws for workflow skills (not yet supported)", () => {
    expect(() =>
      skillRowToAuthorInput(row({ implementationType: "workflow" }), { modelId: "llama3" }),
    ).toThrow(/workflow skills cannot be listed/);
  });
});
