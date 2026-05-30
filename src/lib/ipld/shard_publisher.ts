/**
 * Shard publisher — builds an IPLD Merkle DAG shard for an asset and anchors it
 * to Celestia's data-availability layer (best-effort).
 *
 * This sits between the studio publish flow and the on-chain mint: it produces
 * the `bytes32` merkle root used by DataProvenance and a Celestia commitment
 * proving the shard manifest was published to DA.
 *
 * Anchoring NEVER throws — if the local Celestia node is unreachable the shard
 * is still returned with `celestiaError` set so the caller can proceed and
 * surface a soft warning.
 */

import log from "electron-log";

import { celestiaBlobService } from "@/lib/celestia_blob_service";

import { buildAssetShard, type AssetShard, type BuildShardInput } from "./dag_serializer";

const logger = log.scope("shard_publisher");

export interface ShardAnchor {
  height: number;
  commitment: string;
  namespace: string;
}

export interface ShardResult extends AssetShard {
  /** Present when the shard CAR was anchored to Celestia DA. */
  celestia?: ShardAnchor;
  /** Present when anchoring was skipped or failed (soft warning). */
  celestiaError?: string;
}

export interface BuildAndAnchorOptions {
  /** When false, skip Celestia anchoring entirely (still builds the shard). */
  anchor?: boolean;
}

/**
 * Build the asset shard and, when possible, anchor its CAR to Celestia.
 */
export async function buildAndAnchorShard(
  input: BuildShardInput,
  options?: BuildAndAnchorOptions,
): Promise<ShardResult> {
  const shard = await buildAssetShard(input);
  const result: ShardResult = { ...shard };

  if (options?.anchor === false) {
    result.celestiaError = "anchoring disabled";
    return result;
  }

  try {
    const available = await celestiaBlobService.isAvailable();
    if (!available) {
      result.celestiaError = "celestia node unavailable";
      return result;
    }

    const submission = await celestiaBlobService.submitBlob(Buffer.from(shard.carBytes), {
      namespaceKey: "assets",
      label: `shard:${shard.rootCidStr}`,
      dataType: "asset-shard-car",
    });

    result.celestia = {
      height: submission.height,
      commitment: submission.commitment,
      namespace: submission.namespace,
    };
  } catch (err) {
    const message = (err as Error).message;
    result.celestiaError = message;
    logger.warn(`shard anchor failed for ${shard.rootCidStr}: ${message}`);
  }

  return result;
}
