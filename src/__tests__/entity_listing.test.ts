import { describe, it, expect } from "vitest";

import { agentRowToAuthorInput, type AgentRow } from "@/lib/onchain/entity_listing";

function agent(overrides: Partial<AgentRow>): AgentRow {
  return {
    id: 7,
    name: "Support Bot",
    description: "answers questions",
    type: "chatbot",
    status: "draft",
    appId: null,
    systemPrompt: "You are a helpful support agent.",
    modelId: "llama3.2",
    temperature: null,
    maxTokens: null,
    configJson: null,
    version: "1.0.0",
    publishStatus: "local",
    marketplaceId: null,
    publishedAt: null,
    publishPrice: null,
    publishCurrency: "USD",
    dryRunAt: null,
    erc8004AgentId: null,
    erc8004Chain: null,
    brandKitId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as AgentRow;
}

describe("agentRowToAuthorInput", () => {
  it("maps an agent to a prompt-agent using its system prompt + model", () => {
    const input = agentRowToAuthorInput(agent({}));
    expect(input).toEqual({
      kind: "prompt-agent",
      modelId: "llama3.2",
      systemPrompt: "You are a helpful support agent.",
      promptTemplate: undefined,
      maxTokens: undefined,
      temperature: undefined,
    });
  });

  it("honours explicit option overrides", () => {
    const input = agentRowToAuthorInput(agent({}), {
      modelId: "gpt-5.2",
      systemPrompt: "Override prompt",
      promptTemplate: "{{input}}",
      maxTokens: 2048,
      temperature: 0.5,
    });
    expect(input).toMatchObject({
      modelId: "gpt-5.2",
      systemPrompt: "Override prompt",
      promptTemplate: "{{input}}",
      maxTokens: 2048,
      temperature: 0.5,
    });
  });

  it("falls back to the description when there is no system prompt", () => {
    const input = agentRowToAuthorInput(agent({ systemPrompt: null }));
    expect(input.kind).toBe("prompt-agent");
    if (input.kind === "prompt-agent") {
      expect(input.systemPrompt).toBe("answers questions");
    }
  });

  it("normalizes a stored x100 temperature into the [0,2] range", () => {
    expect(agentRowToAuthorInput(agent({ temperature: 70 })).temperature).toBeCloseTo(0.7);
    expect(agentRowToAuthorInput(agent({ temperature: 1 })).temperature).toBe(1);
    expect(agentRowToAuthorInput(agent({ temperature: 500 })).temperature).toBe(2);
  });

  it("carries a positive maxTokens but ignores zero / negative", () => {
    expect(agentRowToAuthorInput(agent({ maxTokens: 4096 })).maxTokens).toBe(4096);
    expect(agentRowToAuthorInput(agent({ maxTokens: 0 })).maxTokens).toBeUndefined();
  });

  it("throws when no model id can be resolved", () => {
    expect(() => agentRowToAuthorInput(agent({ modelId: null }))).toThrow(/modelId is required/);
  });

  it("throws when neither a prompt nor a description is available", () => {
    expect(() =>
      agentRowToAuthorInput(agent({ systemPrompt: null, description: null })),
    ).toThrow(/system prompt/);
  });
});
