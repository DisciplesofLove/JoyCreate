/**
 * The executors are what an A2A listing actually sells, and the one thing they
 * must get right is telling success from failure.
 *
 * `invokeContract` fails — and therefore refunds — only when the executor
 * throws. Several IPC handlers report failure by *returning*
 * `{ success: false, error }` instead, against the repo convention. Observed
 * live: a document handler that errored on its own arguments produced a
 * `completed` invocation, a `DELIVERED` contract, and a full payout to the
 * provider on verification. The buyer paid for an error message.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

const { registered, invoked } = vi.hoisted(() => ({
  registered: new Map<string, any>(),
  invoked: { calls: [] as Array<{ channel: string; args: unknown[] }>, result: undefined as unknown },
}));

vi.mock("electron-log", () => ({
  default: {
    scope: () => ({ info: () => undefined, warn: () => undefined, error: () => undefined }),
  },
}));

vi.mock("@/ipc/handlers/a2a_handlers", () => ({
  registerA2aExecutor: (capability: string, executor: any) =>
    registered.set(capability, executor),
}));

vi.mock("@/mcp_server/tools/invoke_handler", () => ({
  invokeHandler: async (channel: string, ...args: unknown[]) => {
    invoked.calls.push({ channel, args });
    if (invoked.result instanceof Error) throw invoked.result;
    return invoked.result;
  },
}));

// Type-only import in the module under test, but the mock keeps vitest from
// loading the real engine (and through it Celestia and Electron `app`).
vi.mock("@/lib/a2a_economy", () => ({}));

import { registerBuiltinA2aExecutors } from "@/lib/a2a_executors";
import { CAPABILITY_CHANNELS, isRealCapability } from "@/lib/a2a_capability_catalog";

const contract = { id: "contract-1" } as any;
const listing = { id: "listing-1" } as any;

function executorFor(capability: string) {
  registerBuiltinA2aExecutors();
  const executor = registered.get(capability);
  expect(executor, `no executor registered for ${capability}`).toBeDefined();
  return executor;
}

beforeEach(() => {
  invoked.calls.length = 0;
  invoked.result = undefined;
});

describe("capability catalogue", () => {
  it("registers an executor for every catalogued capability", () => {
    registerBuiltinA2aExecutors();
    for (const capability of Object.keys(CAPABILITY_CHANNELS)) {
      expect(registered.has(capability)).toBe(true);
    }
  });

  it("distinguishes real capabilities from ones that would echo", () => {
    expect(isRealCapability("document.create")).toBe(true);
    // A listing may declare anything; only the catalogue actually runs work.
    expect(isRealCapability("astrology.forecast")).toBe(false);
  });
});

describe("executor success and failure", () => {
  it("passes the invocation input through to the handler unchanged", async () => {
    invoked.result = { success: true, document: { id: 7 } };
    const executor = executorFor("document.create");

    await executor({ contract, listing, input: { name: "doc", type: "document" } });

    expect(invoked.calls[0].channel).toBe("libreoffice:create");
    // Contract identifiers travel in the result, never merged into the input —
    // otherwise a handler that echoes its params could make an invocation look
    // like it carried fields the caller never sent.
    expect(invoked.calls[0].args[0]).toEqual({ name: "doc", type: "document" });
  });

  it("reports the handler result and which channel produced it", async () => {
    invoked.result = { success: true, filePath: "C:/out.odt" };
    const executor = executorFor("document.create");

    const out = await executor({ contract, listing, input: {} });

    expect(out.output.capability).toBe("document.create");
    expect(out.output.channel).toBe("libreoffice:create");
    expect(out.output.contractId).toBe("contract-1");
    expect((out.output.result as any).filePath).toBe("C:/out.odt");
  });

  it("throws when the handler returns a failure instead of throwing", async () => {
    invoked.result = { success: false, error: "Cannot read properties of undefined" };
    const executor = executorFor("document.create");

    await expect(executor({ contract, listing, input: {} })).rejects.toThrow(
      /libreoffice:create reported failure: Cannot read properties of undefined/,
    );
  });

  it("still throws when a returned failure carries no reason", async () => {
    invoked.result = { success: false };
    const executor = executorFor("document.create");

    await expect(executor({ contract, listing, input: {} })).rejects.toThrow(
      /no reason given/,
    );
  });

  it("lets a handler that throws propagate unchanged", async () => {
    invoked.result = new Error("channel exploded");
    const executor = executorFor("image.generate");

    await expect(executor({ contract, listing, input: {} })).rejects.toThrow(
      "channel exploded",
    );
  });

  it("accepts a handler whose result says nothing about success", async () => {
    // Most handlers return their payload directly. Absence of `success: false`
    // is not evidence of failure, and treating it as such would refund work
    // that actually happened.
    invoked.result = { skillId: 12 };
    const executor = executorFor("skill.create");

    const out = await executor({ contract, listing, input: {} });

    expect((out.output.result as any).skillId).toBe(12);
  });

  it("accepts a non-object result", async () => {
    invoked.result = "ok";
    const executor = executorFor("dataset.create");

    const out = await executor({ contract, listing, input: {} });

    expect(out.output.result).toBe("ok");
  });
});
