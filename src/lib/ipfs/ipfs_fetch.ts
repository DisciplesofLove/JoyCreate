/**
 * LR8 — fetch content by CID over public IPFS gateways.
 *
 * The IpfsPinner is write-only (pin), so retrieval lives here. We try each
 * gateway in `IPFS_GATEWAYS` in order with a per-request timeout and a hard
 * byte cap, and reject anything larger than the cap (defends against a
 * malicious CID streaming an unbounded body into memory).
 *
 * Security: callers MUST treat fetched bytes as untrusted. JSON is parsed but
 * never evaluated; skill bundles are declarative manifests, never executable
 * code (see `skill_runtime.ts`).
 */

import { IPFS_GATEWAYS, extractIpfsHash } from "@/utils/ipfsGateway";

/** Default 5 MiB cap — agent cards and skill manifests are small JSON docs. */
export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;

export interface FetchIpfsOptions {
  maxBytes?: number;
  timeoutMs?: number;
  /** Override the gateway list (used in tests). */
  gateways?: string[];
}

function normalizeCid(cidOrUri: string): string {
  const cid = extractIpfsHash(cidOrUri);
  if (!cid) throw new Error(`invalid IPFS CID or URI: ${cidOrUri}`);
  return cid;
}

/** Fetch raw bytes for a CID, trying each gateway until one succeeds. */
export async function fetchIpfsBytes(
  cidOrUri: string,
  opts: FetchIpfsOptions = {},
): Promise<Uint8Array> {
  const cid = normalizeCid(cidOrUri);
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const gateways = opts.gateways ?? IPFS_GATEWAYS;

  const errors: string[] = [];
  for (const gateway of gateways) {
    const url = gateway.endsWith("/") ? `${gateway}${cid}` : `${gateway}/${cid}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) {
        errors.push(`${gateway} -> ${res.status}`);
        continue;
      }
      const declared = res.headers.get("content-length");
      if (declared && Number(declared) > maxBytes) {
        throw new Error(`content exceeds ${maxBytes} byte cap (declared ${declared})`);
      }
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.byteLength > maxBytes) {
        throw new Error(`content exceeds ${maxBytes} byte cap (got ${buf.byteLength})`);
      }
      return buf;
    } catch (err) {
      errors.push(`${gateway} -> ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`failed to fetch ${cid} from all gateways: ${errors.join("; ")}`);
}

/** Fetch and JSON-parse a CID's content (never evaluated). */
export async function fetchIpfsJson<T = unknown>(
  cidOrUri: string,
  opts: FetchIpfsOptions = {},
): Promise<T> {
  const bytes = await fetchIpfsBytes(cidOrUri, opts);
  const text = new TextDecoder().decode(bytes);
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw new Error(`content at ${cidOrUri} is not valid JSON: ${err}`);
  }
}
