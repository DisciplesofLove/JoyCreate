/**
 * IPFS Pin Service
 *
 * Wraps the local Helia node ({@link heliaVerificationService}) for adding /
 * pinning / fetching arbitrary file content (used by Phase 5 sovereign model
 * weight publishing) and provides an optional remote pinning backend
 * (Pinata) when credentials are configured via environment variables:
 *
 *   PINATA_JWT          (preferred)
 *   PINATA_API_KEY      \
 *   PINATA_API_SECRET   /  legacy auth pair
 *
 * If no remote credentials are present, all operations succeed locally only.
 */

import fs from "fs-extra";
import path from "node:path";
import crypto from "node:crypto";
import log from "electron-log";

const logger = log.scope("ipfs_pin_service");
import { heliaVerificationService } from "./helia_verification_service";

export interface IpfsPinResult {
  cid: string;
  bytes: number;
  sha256: string;
  /** True when the file was also pinned to a remote service (e.g. Pinata). */
  remotePinned: boolean;
  remoteProvider?: string;
}

export interface PinataPinResponse {
  IpfsHash: string;
  PinSize: number;
  Timestamp: string;
}

const PINATA_API = "https://api.pinata.cloud";

function pinataAuthHeader(): Record<string, string> | null {
  const jwt = process.env.PINATA_JWT?.trim();
  if (jwt) {
    return { Authorization: `Bearer ${jwt}` };
  }
  const key = process.env.PINATA_API_KEY?.trim();
  const secret = process.env.PINATA_API_SECRET?.trim();
  if (key && secret) {
    return {
      pinata_api_key: key,
      pinata_secret_api_key: secret,
    };
  }
  return null;
}

export function isRemotePinningEnabled(): boolean {
  return pinataAuthHeader() !== null;
}

async function sha256OfFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

async function pinToPinata(
  filePath: string,
  metadata?: { name?: string; keyvalues?: Record<string, string> },
): Promise<PinataPinResponse | null> {
  const headers = pinataAuthHeader();
  if (!headers) return null;

  // Use Node fetch with FormData (Node >=18). Buffer the file (model chunks
  // for now are bounded by callers; switch to streaming if needed).
  const form = new FormData();
  const bytes = await fs.readFile(filePath);
  // Blob is a global in Node 18+ (undici).
  form.append("file", new Blob([new Uint8Array(bytes)]), path.basename(filePath));
  if (metadata) {
    form.append("pinataMetadata", JSON.stringify(metadata));
  }

  const res = await fetch(`${PINATA_API}/pinning/pinFileToIPFS`, {
    method: "POST",
    headers,
    body: form,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Pinata pin failed (${res.status}): ${body}`);
  }
  return (await res.json()) as PinataPinResponse;
}

async function unpinFromPinata(cid: string): Promise<void> {
  const headers = pinataAuthHeader();
  if (!headers) return;
  const res = await fetch(`${PINATA_API}/pinning/unpin/${cid}`, {
    method: "DELETE",
    headers,
  });
  // Pinata returns 200 for success and 404 if the CID is unknown — treat
  // 404 as a no-op so unpin is idempotent.
  if (!res.ok && res.status !== 404) {
    const body = await res.text().catch(() => "");
    throw new Error(`Pinata unpin failed (${res.status}): ${body}`);
  }
}

export const ipfsPinService = {
  isRemotePinningEnabled,

  /**
   * Add a file to the local Helia node, pin it, hash it, and (if configured)
   * pin it to the configured remote service. Returns the CID and metadata.
   */
  async addAndPinFile(
    filePath: string,
    metadata?: { name?: string; keyvalues?: Record<string, string> },
  ): Promise<IpfsPinResult> {
    const exists = await fs.pathExists(filePath);
    if (!exists) throw new Error(`File not found: ${filePath}`);

    const sha256 = await sha256OfFile(filePath);
    const local = await heliaVerificationService.storeModelChunkFile(filePath);
    await heliaVerificationService.pinCid(local.cid);

    let remotePinned = false;
    let remoteProvider: string | undefined;
    if (isRemotePinningEnabled()) {
      try {
        const pin = await pinToPinata(filePath, metadata);
        if (pin) {
          remotePinned = true;
          remoteProvider = "pinata";
          if (pin.IpfsHash !== local.cid) {
            // Helia (CIDv1, raw codec) and Pinata (CIDv0) can differ; both
            // resolve to the same content. Log for debugging.
            logger.info("Pinata returned different CID than local Helia", {
              localCid: local.cid,
              pinataCid: pin.IpfsHash,
            });
          }
        }
      } catch (err) {
        logger.warn("Pinata pin failed; continuing with local pin only", err);
      }
    }

    return {
      cid: local.cid,
      bytes: local.bytes,
      sha256,
      remotePinned,
      remoteProvider,
    };
  },

  /** Pin an existing CID locally (and remotely if available). */
  async pinCid(cid: string): Promise<{ remotePinned: boolean }> {
    await heliaVerificationService.pinCid(cid);
    // Remote re-pin by CID is best-effort: Pinata's pinByHash requires the
    // content to be discoverable on the public DHT, which our offline Helia
    // node does not announce. We skip remote pin-by-cid for now.
    return { remotePinned: false };
  },

  async unpinCid(cid: string): Promise<void> {
    try {
      await heliaVerificationService.unpinCid(cid);
    } catch (err) {
      logger.warn("Local unpin failed (continuing)", err);
    }
    if (isRemotePinningEnabled()) {
      try {
        await unpinFromPinata(cid);
      } catch (err) {
        logger.warn("Remote unpin failed", err);
      }
    }
  },

  async isPinned(cid: string): Promise<boolean> {
    return heliaVerificationService.isCidPinned(cid);
  },

  /** Fetch a CID's content from the local Helia node back to a file. */
  async fetchToFile(cid: string, outputPath: string): Promise<{ bytes: number; sha256: string }> {
    const result = await heliaVerificationService.exportModelChunkToFile(cid, outputPath);
    const sha256 = await sha256OfFile(outputPath);
    return { bytes: result.bytes, sha256 };
  },
};
