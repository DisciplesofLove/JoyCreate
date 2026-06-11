import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  fetchIpfsBytes,
  fetchIpfsJson,
  DEFAULT_MAX_BYTES,
} from "@/lib/ipfs/ipfs_fetch";

const CID = "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG";

function mockResponse(body: string, init?: { status?: number; contentLength?: string }) {
  const headers = new Map<string, string>();
  if (init?.contentLength) headers.set("content-length", init.contentLength);
  return {
    ok: (init?.status ?? 200) >= 200 && (init?.status ?? 200) < 300,
    status: init?.status ?? 200,
    headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null },
    arrayBuffer: async () => new TextEncoder().encode(body).buffer,
  } as unknown as Response;
}

describe("ipfs_fetch", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects an invalid CID", async () => {
    await expect(fetchIpfsBytes("not-a-cid")).rejects.toThrow(/invalid IPFS CID/);
  });

  it("returns bytes from the first working gateway", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse("hello"));
    vi.stubGlobal("fetch", fetchMock);
    const bytes = await fetchIpfsBytes(CID, { gateways: ["https://gw1/ipfs/"] });
    expect(new TextDecoder().decode(bytes)).toBe("hello");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("falls through to the next gateway on failure", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockResponse("", { status: 500 }))
      .mockResolvedValueOnce(mockResponse("ok2"));
    vi.stubGlobal("fetch", fetchMock);
    const bytes = await fetchIpfsBytes(CID, {
      gateways: ["https://gw1/ipfs/", "https://gw2/ipfs/"],
    });
    expect(new TextDecoder().decode(bytes)).toBe("ok2");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws when all gateways fail", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse("", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      fetchIpfsBytes(CID, { gateways: ["https://gw1/ipfs/"] }),
    ).rejects.toThrow(/failed to fetch/);
  });

  it("rejects content over the byte cap via declared content-length", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        mockResponse("x", { contentLength: String(DEFAULT_MAX_BYTES + 1) }),
      );
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      fetchIpfsBytes(CID, { gateways: ["https://gw1/ipfs/"] }),
    ).rejects.toThrow(/failed to fetch/);
  });

  it("parses JSON content", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse(JSON.stringify({ a: 1 })));
    vi.stubGlobal("fetch", fetchMock);
    const json = await fetchIpfsJson<{ a: number }>(CID, { gateways: ["https://gw1/ipfs/"] });
    expect(json.a).toBe(1);
  });

  it("throws on non-JSON content for fetchIpfsJson", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse("not json"));
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      fetchIpfsJson(CID, { gateways: ["https://gw1/ipfs/"] }),
    ).rejects.toThrow(/not valid JSON/);
  });
});
