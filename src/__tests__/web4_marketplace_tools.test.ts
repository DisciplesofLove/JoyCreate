/**
 * web4_marketplace_tools — LR5 MCP tool surface unit tests.
 *
 * Drives `registerWeb4MarketplaceTools` with a fake McpServer that captures each
 * tool handler, and a mocked `ipcMain._invokeHandlers` map so no real IPC/RPC is
 * touched. Asserts the new LR2–LR5 tools and the mandate-routing on purchase.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { invokeHandlers } = vi.hoisted(() => ({
  invokeHandlers: new Map<string, (...args: any[]) => any>(),
}));

const { invokeSkillRuntimeMock } = vi.hoisted(() => ({
  invokeSkillRuntimeMock: vi.fn(),
}));

vi.mock("electron", () => ({
  ipcMain: { _invokeHandlers: invokeHandlers },
}));

vi.mock("@/lib/onchain/skill_runtime", () => ({
  invokeSkillRuntime: invokeSkillRuntimeMock,
}));

import { registerWeb4MarketplaceTools } from "@/mcp_server/tools/web4_marketplace_tools";

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
}>;

function collectTools(): Map<string, ToolHandler> {
  const tools = new Map<string, ToolHandler>();
  const fakeServer = {
    registerTool: (name: string, _config: unknown, handler: ToolHandler) => {
      tools.set(name, handler);
    },
  };
  registerWeb4MarketplaceTools(fakeServer as never);
  return tools;
}

async function callJson(handler: ToolHandler, args: Record<string, unknown>) {
  const res = await handler(args);
  return JSON.parse(res.content[0].text);
}

let tools: Map<string, ToolHandler>;

beforeEach(() => {
  invokeHandlers.clear();
  invokeSkillRuntimeMock.mockReset();
  tools = collectTools();
});

describe("registered tool surface", () => {
  it("registers the full LR1–LR5 flow", () => {
    for (const name of [
      "store_register",
      "drop_launch",
      "discover",
      "purchase_execute",
      "agent_authorize",
      "reputation_submit",
      "license_check",
      "runtime_invoke",
    ]) {
      expect(tools.has(name)).toBe(true);
    }
  });
});

describe("license_check", () => {
  it("allows a granted use", async () => {
    const out = await callJson(tools.get("license_check")!, {
      use: "runtimeExecution",
      terms: { runtimeExecution: true },
    });
    expect(out.allowed).toBe(true);
    expect(out.use).toBe("runtimeExecution");
  });

  it("denies a use the SPDX default does not grant", async () => {
    const out = await callJson(tools.get("license_check")!, {
      use: "commercial",
      spdx: "CC-BY-4.0",
    });
    expect(out.allowed).toBe(false);
    expect(out.reason).toContain("commercial");
  });
});

describe("runtime_invoke", () => {
  it("denies when the license does not grant runtimeExecution", async () => {
    const out = await callJson(tools.get("runtime_invoke")!, {
      agentId: "5",
      terms: { runtimeExecution: false },
    });
    expect(out.invoked).toBe(false);
    expect(out.reason).toContain("runtime");
  });

  it("returns the runtime manifest when granted and the agent exposes one", async () => {
    invokeHandlers.set("broker:agent-blueprint", async () => ({
      runtime: { agentCardCid: "bafycard", agentCardUri: "ipfs://bafycard" },
    }));
    const out = await callJson(tools.get("runtime_invoke")!, {
      agentId: "5",
      terms: { runtimeExecution: true },
    });
    expect(out.invoked).toBe(true);
    expect(out.runtime.agentCardCid).toBe("bafycard");
  });

  it("errors when the agent exposes no runtime manifest", async () => {
    invokeHandlers.set("broker:agent-blueprint", async () => ({ runtime: undefined }));
    const res = await tools.get("runtime_invoke")!({
      agentId: "5",
      terms: { runtimeExecution: true },
    });
    expect(res.content[0].text).toContain("no runtime manifest");
  });

  it("executes the skill locally when an input is supplied (LR8)", async () => {
    invokeHandlers.set("broker:agent-blueprint", async () => ({
      runtime: { agentCardCid: "bafycard", agentCardUri: "ipfs://bafycard" },
    }));
    invokeSkillRuntimeMock.mockResolvedValue({
      output: "hello world",
      modelId: "llama3",
      finishReason: "stop",
      agentId: "5",
      skillCid: "QmSkill",
    });
    const out = await callJson(tools.get("runtime_invoke")!, {
      agentId: "5",
      input: "say hi",
      terms: { runtimeExecution: true },
      dropId: "7",
      buyer: "0xbuyer",
    });
    expect(out.invoked).toBe(true);
    expect(out.executionMode).toContain("local-ipld");
    expect(out.output).toBe("hello world");
    expect(out.skillCid).toBe("QmSkill");
    expect(invokeSkillRuntimeMock).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "5", input: "say hi", dropId: "7", buyer: "0xbuyer" }),
    );
  });
});

describe("purchase_execute mandate routing", () => {
  it("routes to the plain purchase channel without a mandate", async () => {
    const calls: string[] = [];
    invokeHandlers.set("x402:purchase-edition", async () => {
      calls.push("plain");
      return { tokenId: "1" };
    });
    invokeHandlers.set("x402:purchase-edition-with-mandate", async () => {
      calls.push("mandate");
      return { tokenId: "2" };
    });
    await callJson(tools.get("purchase_execute")!, { dropId: "7" });
    expect(calls).toEqual(["plain"]);
  });

  it("routes to the mandate channel when a mandateId is supplied", async () => {
    const calls: string[] = [];
    invokeHandlers.set("x402:purchase-edition", async () => {
      calls.push("plain");
      return { tokenId: "1" };
    });
    invokeHandlers.set("x402:purchase-edition-with-mandate", async (_e: unknown, p: any) => {
      calls.push("mandate");
      expect(p.mandateId).toBe("4");
      return { tokenId: "2", mandateId: "4" };
    });
    const out = await callJson(tools.get("purchase_execute")!, { dropId: "7", mandateId: "4" });
    expect(calls).toEqual(["mandate"]);
    expect(out.mandateId).toBe("4");
  });
});

describe("agent_authorize", () => {
  it("creates a mandate and binds the store agent when storeId is supplied", async () => {
    invokeHandlers.set("glue:create-mandate", async () => ({ mandateId: "9" }));
    invokeHandlers.set("glue:set-store-agent", async () => ({ txHash: "0xsetagent" }));
    const out = await callJson(tools.get("agent_authorize")!, {
      agent: "0xagent",
      spendLimit: "5000000",
      storeId: "1",
      agentId: "9",
    });
    expect(out.mandate.mandateId).toBe("9");
    expect(out.setAgent.txHash).toBe("0xsetagent");
  });

  it("errors when storeId is supplied without agentId", async () => {
    invokeHandlers.set("glue:create-mandate", async () => ({ mandateId: "9" }));
    const res = await tools.get("agent_authorize")!({
      agent: "0xagent",
      spendLimit: "5000000",
      storeId: "1",
    });
    expect(res.content[0].text).toContain("agentId is required");
  });
});
