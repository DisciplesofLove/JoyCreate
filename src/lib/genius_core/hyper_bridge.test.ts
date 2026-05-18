/**
 * Tests for the Genius Core ↔ Hypercore peer-layer bridge.
 *
 * Verifies the gating, payload size cap, fire-and-forget semantics, and
 * that `tryAppend` is invoked with the correct scope/subjectId/event when
 * the bridge is enabled.
 */

import { describe, expect, it, beforeEach, vi } from "vitest";

const hoisted = vi.hoisted(() => {
  const readSettingsMock = vi.fn();
  const tryAppendMock = vi.fn(async () => ({
    seq: 0,
    hashHex: "deadbeef",
    discoveryKeyHex: "00".repeat(32),
  }));
  const HyperLogStoreMock = vi.fn().mockImplementation(() => ({
    tryAppend: tryAppendMock,
  }));
  return { readSettingsMock, tryAppendMock, HyperLogStoreMock };
});

vi.mock("electron-log", () => {
  const noop = () => undefined;
  const scope = () => ({ info: noop, warn: noop, error: noop, debug: noop });
  return {
    default: { scope, info: noop, warn: noop, error: noop, debug: noop },
    scope,
  };
});

vi.mock("@/main/settings", () => ({
  readSettings: () => hoisted.readSettingsMock(),
}));

vi.mock("@/lib/hyper/hyper_log_store", () => ({
  HyperLogStore: hoisted.HyperLogStoreMock,
}));

import { mirrorGeniusCoreEvent } from "@/lib/genius_core/hyper_bridge";

/** Wait for the fire-and-forget IIFE inside `mirrorGeniusCoreEvent` to settle. */
const flush = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
  hoisted.readSettingsMock.mockReset();
  hoisted.tryAppendMock.mockClear();
  hoisted.HyperLogStoreMock.mockClear();
});

describe("mirrorGeniusCoreEvent", () => {
  it("no-ops when projectId is empty", async () => {
    mirrorGeniusCoreEvent("", {
      type: "slot",
      projectId: "",
      cid: "bafy",
      baseModelId: "phi-3",
      ts: 1,
    });
    await flush();
    expect(hoisted.readSettingsMock).not.toHaveBeenCalled();
    expect(hoisted.tryAppendMock).not.toHaveBeenCalled();
  });

  it("no-ops when hyperReplicationEnabled is false", async () => {
    hoisted.readSettingsMock.mockReturnValue({
      geniusCore: { hyperReplicationEnabled: false },
    });
    mirrorGeniusCoreEvent("p1", {
      type: "slot",
      projectId: "p1",
      cid: "bafy",
      baseModelId: "phi-3",
      ts: 1,
    });
    await flush();
    expect(hoisted.tryAppendMock).not.toHaveBeenCalled();
  });

  it("no-ops when global hyperEnabled is explicitly false", async () => {
    hoisted.readSettingsMock.mockReturnValue({
      geniusCore: { hyperReplicationEnabled: true },
      hyperEnabled: false,
    });
    mirrorGeniusCoreEvent("p1", {
      type: "slot",
      projectId: "p1",
      cid: "bafy",
      baseModelId: "phi-3",
      ts: 1,
    });
    await flush();
    expect(hoisted.tryAppendMock).not.toHaveBeenCalled();
  });

  it("appends with scope genius-core and projectId subject on happy path", async () => {
    hoisted.readSettingsMock.mockReturnValue({
      geniusCore: { hyperReplicationEnabled: true },
    });
    const event = {
      type: "slot" as const,
      projectId: "proj-42",
      cid: "bafyabc",
      baseModelId: "phi-3",
      previousCid: null,
      ts: 1234,
    };
    mirrorGeniusCoreEvent("proj-42", event);
    await flush();

    expect(hoisted.HyperLogStoreMock).toHaveBeenCalledWith(
      "genius-core",
      "proj-42",
    );
    expect(hoisted.tryAppendMock).toHaveBeenCalledWith(event);
  });

  it("drops events larger than 2KB", async () => {
    hoisted.readSettingsMock.mockReturnValue({
      geniusCore: { hyperReplicationEnabled: true },
    });
    const fat = "x".repeat(4096);
    mirrorGeniusCoreEvent("p1", {
      type: "distill",
      projectId: "p1",
      adapterId: fat,
      method: "qlora",
      sampleCount: 1,
      finalLoss: 0,
      durationMs: 0,
      baseModelId: "phi-3",
      ts: 1,
    });
    await flush();
    expect(hoisted.tryAppendMock).not.toHaveBeenCalled();
  });

  it("never throws when settings access fails", async () => {
    hoisted.readSettingsMock.mockImplementation(() => {
      throw new Error("boom");
    });
    expect(() =>
      mirrorGeniusCoreEvent("p1", {
        type: "edits",
        projectId: "p1",
        batchHash: "h",
        count: 1,
        firstSeq: 1,
        lastSeq: 1,
        ts: 1,
      }),
    ).not.toThrow();
    await flush();
    expect(hoisted.tryAppendMock).not.toHaveBeenCalled();
  });
});
