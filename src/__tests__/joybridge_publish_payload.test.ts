/**
 * `joybridge:publish-asset` — payload threading into the canonical pipeline.
 *
 * This is the seam between the renderer (CreateAssetWizard, the Joy publish
 * page, the studio publish menus) and `publishAndForget`. It is easy to get
 * silently wrong: a field that fails to cross the boundary does not throw, it
 * just produces a listing missing its cover art, its traits, or — worst — its
 * store, and nobody notices until the asset is already immutable on-chain.
 *
 * These tests assert what actually reaches the orchestrator.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const handlersByChannel = new Map<string, (...args: unknown[]) => unknown>();

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      handlersByChannel.set(channel, fn);
    },
  },
  app: { getPath: () => process.cwd() },
}));

vi.mock("electron-log", () => ({
  default: {
    scope: () => ({
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    }),
  },
}));

vi.mock("fs-extra", () => ({
  pathExists: async () => false,
  readJson: async () => ({}),
  writeJson: async () => undefined,
}));

const { publishSpy } = vi.hoisted(() => ({ publishSpy: vi.fn() }));

vi.mock("@/lib/joymarketplace/publish_orchestrator", () => ({
  publishAndForget: publishSpy,
}));

import { registerJoyBridgeHandlers } from "@/ipc/handlers/joybridge_handlers";

type PublishInput = {
  storeSlug?: string;
  contentBuffer?: Buffer;
  contentMimeType?: string;
  coverImage?: { bytes: Buffer; mimeType: string; fileName: string };
  coverImageCid?: string;
  extraAttributes?: Array<{ trait_type: string; value: string }>;
  priceUsdc?: number;
  royaltyBps?: number;
  license?: string;
  assetType?: string;
  name?: string;
};

async function invokePublish(input: Record<string, unknown>) {
  handlersByChannel.clear();
  publishSpy.mockReset();
  publishSpy.mockResolvedValue({ ok: true, tokenId: "1", errors: [] });
  registerJoyBridgeHandlers();
  const fn = handlersByChannel.get("joybridge:publish-asset");
  if (!fn) throw new Error("joybridge:publish-asset was not registered");
  await fn({}, input);
  return publishSpy.mock.calls[0][0] as PublishInput;
}

const BASE = {
  storeId: "acme-models",
  name: "Test Asset",
  assetType: "model",
  properties: { storeSlug: "acme-models" },
};

describe("joybridge:publish-asset payload", () => {
  beforeEach(() => {
    handlersByChannel.clear();
    publishSpy.mockReset();
  });

  it("decodes base64 content into the buffer the pipeline encrypts", async () => {
    const payload = Buffer.from("model weights go here");
    const got = await invokePublish({
      ...BASE,
      contentBase64: payload.toString("base64"),
      contentMimeType: "application/octet-stream",
    });
    expect(got.contentBuffer?.equals(payload)).toBe(true);
    expect(got.contentMimeType).toBe("application/octet-stream");
  });

  it("decodes a base64 cover image with its filename and mime type", async () => {
    const cover = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const got = await invokePublish({
      ...BASE,
      contentBase64: Buffer.from("x").toString("base64"),
      coverImageBase64: cover.toString("base64"),
      coverImageMimeType: "image/png",
      coverImageFileName: "cover.png",
    });
    expect(got.coverImage?.bytes.equals(cover)).toBe(true);
    expect(got.coverImage?.mimeType).toBe("image/png");
    expect(got.coverImage?.fileName).toBe("cover.png");
  });

  it("defaults cover mime and filename rather than dropping the image", async () => {
    const got = await invokePublish({
      ...BASE,
      contentBase64: Buffer.from("x").toString("base64"),
      coverImageBase64: Buffer.from("y").toString("base64"),
    });
    expect(got.coverImage?.mimeType).toBe("image/png");
    expect(got.coverImage?.fileName).toBe("cover.png");
  });

  it("passes a pre-pinned cover CID straight through", async () => {
    const got = await invokePublish({
      ...BASE,
      contentBase64: Buffer.from("x").toString("base64"),
      coverImageCid: "bafyCover",
    });
    expect(got.coverImageCid).toBe("bafyCover");
    expect(got.coverImage).toBeUndefined();
  });

  it("forwards extra attributes so listing traits survive the boundary", async () => {
    const attributes = [
      { trait_type: "Model Type", value: "language" },
      { trait_type: "Quality Score", value: "92" },
    ];
    const got = await invokePublish({
      ...BASE,
      contentBase64: Buffer.from("x").toString("base64"),
      extraAttributes: attributes,
    });
    expect(got.extraAttributes).toEqual(attributes);
  });

  it("omits the cover entirely when none was supplied", async () => {
    const got = await invokePublish({
      ...BASE,
      contentBase64: Buffer.from("x").toString("base64"),
    });
    expect(got.coverImage).toBeUndefined();
    expect(got.coverImageCid).toBeUndefined();
  });

  it("carries the store slug — the drop contract is derived from it", async () => {
    const got = await invokePublish({
      ...BASE,
      contentBase64: Buffer.from("x").toString("base64"),
    });
    expect(got.storeSlug).toBe("acme-models");
  });

  it("falls back to storeId when properties.storeSlug is absent", async () => {
    const got = await invokePublish({
      storeId: "fallback-store",
      name: "Test Asset",
      assetType: "model",
      contentBase64: Buffer.from("x").toString("base64"),
    });
    expect(got.storeSlug).toBe("fallback-store");
  });

  it("preserves price and royalty exactly, including zero", async () => {
    const got = await invokePublish({
      ...BASE,
      contentBase64: Buffer.from("x").toString("base64"),
      priceUsdc: 0,
      royaltyBps: 0,
    });
    // 0 must survive: `?? undefined` on a falsy number would silently become
    // the 250bps default and start charging a royalty nobody asked for.
    expect(got.priceUsdc).toBe(0);
    expect(got.royaltyBps).toBe(0);
  });
});
