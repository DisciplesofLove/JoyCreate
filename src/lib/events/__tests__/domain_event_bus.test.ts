/**
 * Tests focus on subscriber semantics: ordering, error isolation, and that
 * unsubscribe stops further deliveries. The persistence layer is mocked so
 * the test does not need a SQLite instance.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../event_log", () => ({
  recordDomainEvent: vi.fn(async () => ({ id: 42, occurredAt: new Date(0) })),
}));

import { getDomainEventBus } from "../domain_event_bus";

describe("DomainEventBus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("delivers the persisted envelope id to subscribers", async () => {
    const bus = getDomainEventBus();
    const seen: number[] = [];
    const off = bus.on("agent.invoked", (env) => {
      seen.push(env.id);
    });

    await bus.publish("agent.invoked", {
      agentRef: "a1",
      agentName: "Test",
      callerKind: "owner",
    });

    // setImmediate is used internally — flush
    await new Promise((r) => setImmediate(r));

    expect(seen).toEqual([42]);
    off();
  });

  it("isolates subscriber errors so the publisher never throws", async () => {
    const bus = getDomainEventBus();
    let goodCalled = false;
    const offBad = bus.on("agent.invoked", () => {
      throw new Error("subscriber blew up");
    });
    const offGood = bus.on("agent.invoked", () => {
      goodCalled = true;
    });

    await expect(
      bus.publish("agent.invoked", {
        agentRef: "a1",
        agentName: "Test",
        callerKind: "owner",
      }),
    ).resolves.toBeDefined();

    await new Promise((r) => setImmediate(r));
    expect(goodCalled).toBe(true);
    offBad();
    offGood();
  });

  it("stops delivering after unsubscribe", async () => {
    const bus = getDomainEventBus();
    let count = 0;
    const off = bus.on("agent.invoked", () => {
      count += 1;
    });

    await bus.publish("agent.invoked", { agentRef: "x", agentName: "x", callerKind: "owner" });
    await new Promise((r) => setImmediate(r));
    off();
    await bus.publish("agent.invoked", { agentRef: "x", agentName: "x", callerKind: "owner" });
    await new Promise((r) => setImmediate(r));

    expect(count).toBe(1);
  });
});
