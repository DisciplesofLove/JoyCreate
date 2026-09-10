/**
 * Pinning through the marketplace's own `ipfs-upload` edge function.
 *
 * JoyCreate already has `IpfsPinner` (Pinata/Helia direct), but the canonical
 * publish path deliberately does NOT use it: the marketplace's buyers resolve
 * content through the CIDs its own function produces, and one of the calls here
 * depends on a Pinata behaviour that only that function exposes — see
 * `uploadJsonDirectory`.
 *
 * Byte-for-byte mirror of `scripts/publish-asset.mjs`'s upload helpers, so a
 * JoyCreate publish and a CLI publish produce identical CIDs for identical
 * bytes.
 */

import log from "electron-log";

import { JOYMARKETPLACE_API } from "@/config/joymarketplace";
import type { MarketplaceSession } from "./marketplace_session";

const logger = log.scope("marketplace_ipfs");

const SUPABASE_URL = JOYMARKETPLACE_API.supabaseUrl;
const SUPABASE_ANON_KEY = JOYMARKETPLACE_API.supabaseAnonKey;

interface IpfsUploadBody {
  fileData: string;
  encoding?: "base64";
  fileName: string;
  contentType: string;
  metadata: { name: string };
}

async function invokeIpfsUpload(
  session: MarketplaceSession,
  body: IpfsUploadBody,
): Promise<string> {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/ipfs-upload`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      apikey: SUPABASE_ANON_KEY,
      authorization: `Bearer ${session.accessToken}`,
    },
    body: JSON.stringify(body),
  });

  let json: any = {};
  try {
    json = await res.json();
  } catch {
    /* fall through to the status-based error below */
  }

  if (!res.ok || !json?.success || !json?.ipfsHash) {
    throw new Error(
      `IPFS upload failed (${res.status}): ${json?.error ?? "no CID returned"}`,
    );
  }
  return json.ipfsHash as string;
}

/** Pin raw bytes. Returns a bare CID. */
export async function uploadBinaryToIPFS(
  session: MarketplaceSession,
  bytes: Uint8Array | Buffer,
  contentType: string,
  name: string,
): Promise<string> {
  const cid = await invokeIpfsUpload(session, {
    fileData: Buffer.from(bytes).toString("base64"),
    encoding: "base64",
    fileName: name,
    contentType,
    metadata: { name },
  });
  return cid;
}

/** Pin a JSON document. Returns a bare CID. */
export async function uploadJsonToIPFS(
  session: MarketplaceSession,
  obj: unknown,
  name: string,
): Promise<string> {
  return invokeIpfsUpload(session, {
    fileData: JSON.stringify(obj),
    contentType: "application/json",
    fileName: name,
    metadata: { name },
  });
}

/**
 * Pin `obj` as a file named `<tokenId>` inside an IPFS *directory*, and return
 * the directory's CID.
 *
 * This exists because `JoyStoreDrop1155.uri()` computes
 * `baseURI + tokenId.toString()` unconditionally, so the baseURI handed to
 * `lazyMint` must be a directory containing a file literally named for the
 * token. A flat single-file pin yields `ipfs://<fileCid><tokenId>`, which 404s
 * forever — `_batchURI` is write-once in `lazyMint` with no setter.
 *
 * The trick (and it is a trick, borrowed from `publish-asset.mjs`): putting a
 * folder segment in `fileName` makes Pinata wrap the file in a directory and
 * return the directory CID instead of the file CID.
 */
export async function uploadMetadataDirectory(
  session: MarketplaceSession,
  metadata: unknown,
  tokenId: bigint | string,
): Promise<{ cid: string; uri: string }> {
  const cid = await uploadJsonToIPFS(session, metadata, `meta/${tokenId}`);
  const uri = `ipfs://${cid}/`;
  logger.info(`metadata directory pinned for token ${tokenId}: ${cid}`);
  return { cid, uri };
}

/** Resolve an `ipfs://` URI through the configured public gateway. */
export function ipfsGatewayUrl(uri: string): string {
  const gw = (process.env.JOY_IPFS_GATEWAY || "https://ipfs.io/ipfs/").replace(
    /\/?$/,
    "/",
  );
  return gw + uri.replace(/^ipfs:\/\//, "");
}
