/**
 * Studio job queue IPC handlers — query and control the async job runner
 * defined in `@/lib/studio_jobs`. Job creation lives with each domain (e.g.
 * `video-studio:generate-async` in video_studio_handlers) so this file only
 * exposes read + cancel operations.
 */

import { ipcMain } from "electron";
import { desc, eq } from "drizzle-orm";

import { db } from "@/db";
import { studioJobs } from "@/db/schema";
import { cancelJob, type StudioJobKind, type StudioJobStatus } from "@/lib/studio_jobs";

export interface StudioJobDto {
  id: string;
  kind: StudioJobKind;
  provider: string | null;
  status: StudioJobStatus;
  progress: number;
  params: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

interface ListStudioJobsParams {
  limit?: number;
  status?: StudioJobStatus;
}

function toDto(row: typeof studioJobs.$inferSelect): StudioJobDto {
  return {
    id: row.id,
    kind: row.kind,
    provider: row.provider ?? null,
    status: row.status,
    progress: row.progress,
    params: row.paramsJson ?? null,
    result: row.resultJson ?? null,
    error: row.error ?? null,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
    startedAt: row.startedAt ? row.startedAt.getTime() : null,
    finishedAt: row.finishedAt ? row.finishedAt.getTime() : null,
  };
}

export function registerStudioJobsHandlers() {
  ipcMain.handle("studio-jobs:list", async (_, params?: ListStudioJobsParams) => {
    const limit = Math.min(Math.max(params?.limit ?? 50, 1), 500);
    const rows = params?.status
      ? await db
          .select()
          .from(studioJobs)
          .where(eq(studioJobs.status, params.status))
          .orderBy(desc(studioJobs.createdAt))
          .limit(limit)
      : await db
          .select()
          .from(studioJobs)
          .orderBy(desc(studioJobs.createdAt))
          .limit(limit);
    return rows.map(toDto);
  });

  ipcMain.handle("studio-jobs:get", async (_, id: string) => {
    if (!id) throw new Error("Job id is required");
    const row = await db.select().from(studioJobs).where(eq(studioJobs.id, id)).get();
    if (!row) throw new Error(`Job not found: ${id}`);
    return toDto(row);
  });

  ipcMain.handle("studio-jobs:cancel", async (_, id: string) => {
    if (!id) throw new Error("Job id is required");
    await cancelJob(id);
    const row = await db.select().from(studioJobs).where(eq(studioJobs.id, id)).get();
    if (!row) throw new Error(`Job not found: ${id}`);
    return toDto(row);
  });
}
