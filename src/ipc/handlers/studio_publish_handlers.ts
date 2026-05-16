/**
 * Studio publish IPC handlers — Phase 1C.
 *
 * Wraps the `PublishOrchestrator.publishAndForget` flow with studio-aware
 * lookups so the renderer-side `PublishContextMenu` can publish a generated
 * image/video/dataset directly from the studio surfaces.
 *
 * Channels:
 *   studio:publish-image      → PublishOutcome
 *   studio:publish-video      → PublishOutcome
 *
 * (Dataset publish lives in dataset_studio_handlers.ts — Phase 1D.)
 */

import { ipcMain } from "electron";
import log from "electron-log";
import { eq } from "drizzle-orm";
import * as fs from "node:fs";
import * as path from "node:path";

import { db } from "@/db";
import { imageStudioImages, videoStudioVideos } from "@/db/schema";
import {
  publishAndForget,
  type PublishOutcome,
} from "@/lib/joymarketplace/publish_orchestrator";

const logger = log.scope("studio_publish_handlers");

interface StudioPublishArgs {
  /** Numeric id of the row in image_studio_images / video_studio_videos. */
  assetId: number;
  /** Override display name; defaults to a derived name from prompt/file. */
  name?: string;
  description?: string;
  /** USDC base units (6 decimals); default 0 = free listing. */
  priceUsdc?: number;
  royaltyBps?: number;
  /** When true: pin + estimate gas, no on-chain writes. */
  dryRun?: boolean;
}

function deriveName(prompt: string | null, filePath: string): string {
  if (prompt && prompt.trim().length > 0) {
    return prompt.trim().slice(0, 60);
  }
  return path.basename(filePath);
}

function readBufferOrThrow(filePath: string): Buffer {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Studio asset file not found on disk: ${filePath}`);
  }
  return fs.readFileSync(filePath);
}

function inferImageMime(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "image/png";
}

export function registerStudioPublishHandlers(): void {
  ipcMain.handle("studio:publish-image", async (_e, args: StudioPublishArgs): Promise<PublishOutcome> => {
    if (typeof args?.assetId !== "number") throw new Error("assetId is required");

    const row = await db
      .select()
      .from(imageStudioImages)
      .where(eq(imageStudioImages.id, args.assetId))
      .get();
    if (!row) throw new Error(`Image not found: ${args.assetId}`);

    const buffer = readBufferOrThrow(row.filePath);
    const outcome = await publishAndForget({
      assetType: "image",
      name: args.name ?? deriveName(row.prompt, row.filePath),
      description: args.description ?? row.prompt ?? undefined,
      contentBuffer: buffer,
      contentMimeType: inferImageMime(row.filePath),
      metadata: {
        sourceTable: "image_studio_images",
        sourceId: row.id,
        provider: row.provider,
        model: row.model,
        width: row.width,
        height: row.height,
        provenance: row.provenanceJson ?? null,
      },
      priceUsdc: args.priceUsdc ?? 0,
      royaltyBps: args.royaltyBps ?? 250,
      dryRun: args.dryRun,
    });

    logger.info(`image ${args.assetId} publish outcome ok=${outcome.ok}`);
    return outcome;
  });

  ipcMain.handle("studio:publish-video", async (_e, args: StudioPublishArgs): Promise<PublishOutcome> => {
    if (typeof args?.assetId !== "number") throw new Error("assetId is required");

    const row = await db
      .select()
      .from(videoStudioVideos)
      .where(eq(videoStudioVideos.id, args.assetId))
      .get();
    if (!row) throw new Error(`Video not found: ${args.assetId}`);

    const buffer = readBufferOrThrow(row.filePath);
    const outcome = await publishAndForget({
      assetType: "video",
      name: args.name ?? deriveName(row.prompt, row.filePath),
      description: args.description ?? row.prompt ?? undefined,
      contentBuffer: buffer,
      contentMimeType: "video/mp4",
      metadata: {
        sourceTable: "video_studio_videos",
        sourceId: row.id,
        provider: row.provider,
        model: row.model,
        width: row.width,
        height: row.height,
        duration: row.duration,
        fps: row.fps,
        provenance: row.provenanceJson ?? null,
      },
      priceUsdc: args.priceUsdc ?? 0,
      royaltyBps: args.royaltyBps ?? 250,
      dryRun: args.dryRun,
    });

    logger.info(`video ${args.assetId} publish outcome ok=${outcome.ok}`);
    return outcome;
  });

  logger.info("studio publish handlers registered");
}
