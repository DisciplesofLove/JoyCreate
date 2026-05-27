/**
 * Brand Kit Handlers
 *
 * CRUD + asset upload for user-scoped brand kits. Throws on error.
 *
 * Channels:
 *   brand-kit:list
 *   brand-kit:get
 *   brand-kit:create
 *   brand-kit:update
 *   brand-kit:delete
 *   brand-kit:upload-asset       — copies a local image into userData/brand-kits/<id>/
 */

import fs from "node:fs/promises";
import path from "node:path";

import log from "electron-log";
import { eq, desc } from "drizzle-orm";

import { db } from "../../db";
import {
  brandKits,
  type BrandColorTokens,
  type BrandFontStack,
  type BrandKitRow,
} from "../../db/brand_kit_schema";
import { agents } from "../../db/schema";
import { getUserDataPath } from "../../paths/paths";
import { createLoggedHandler } from "./safe_handle";

const logger = log.scope("brand_kit");
const handle = createLoggedHandler(logger);

export interface BrandKitDto {
  id: number;
  name: string;
  description: string | null;
  logoUrl: string | null;
  wordmarkUrl: string | null;
  colorTokens: BrandColorTokens | null;
  fontStack: BrandFontStack | null;
  voiceGuide: string | null;
  doNot: string[];
  tagline: string | null;
  isDefault: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface BrandKitCreateInput {
  name: string;
  description?: string | null;
  logoUrl?: string | null;
  wordmarkUrl?: string | null;
  colorTokens?: BrandColorTokens | null;
  fontStack?: BrandFontStack | null;
  voiceGuide?: string | null;
  doNot?: string[];
  tagline?: string | null;
  isDefault?: boolean;
}

export type BrandKitUpdateInput = Partial<BrandKitCreateInput>;

export interface BrandKitUploadInput {
  brandKitId: number;
  /** Absolute path to a source file on the user's machine. */
  sourcePath: string;
  /** Logical slot. `logo` writes to logoUrl, `wordmark` to wordmarkUrl. */
  slot: "logo" | "wordmark";
}

function toDto(row: BrandKitRow): BrandKitDto {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    logoUrl: row.logoUrl,
    wordmarkUrl: row.wordmarkUrl,
    colorTokens: (row.colorTokens as BrandColorTokens | null) ?? null,
    fontStack: (row.fontStack as BrandFontStack | null) ?? null,
    voiceGuide: row.voiceGuide,
    doNot: (row.doNotJson as string[] | null) ?? [],
    tagline: row.tagline,
    isDefault: row.isDefault,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

function validateName(name: unknown): string {
  if (typeof name !== "string" || name.trim().length === 0) {
    throw new Error("brand-kit: name is required");
  }
  if (name.length > 200) {
    throw new Error("brand-kit: name must be \u2264 200 chars");
  }
  return name.trim();
}

function brandKitAssetDir(brandKitId: number): string {
  return path.join(getUserDataPath(), "brand-kits", String(brandKitId));
}

async function clearDefaultsExcept(id: number | null): Promise<void> {
  if (id === null) {
    await db.update(brandKits).set({ isDefault: false, updatedAt: new Date() });
    return;
  }
  await db
    .update(brandKits)
    .set({ isDefault: false, updatedAt: new Date() });
  await db
    .update(brandKits)
    .set({ isDefault: true, updatedAt: new Date() })
    .where(eq(brandKits.id, id));
}

/**
 * Build a markdown block describing the brand kit for injection into a
 * system prompt. Returns empty string if id is null or kit not found.
 */
export async function renderBrandKitBlock(
  brandKitId: number | null | undefined,
): Promise<string> {
  if (!brandKitId) return "";
  const [row] = await db
    .select()
    .from(brandKits)
    .where(eq(brandKits.id, brandKitId))
    .limit(1);
  if (!row) return "";

  const lines: string[] = ["## Brand Kit", `Name: ${row.name}`];
  if (row.tagline) lines.push(`Tagline: ${row.tagline}`);
  if (row.voiceGuide) {
    lines.push("", "### Voice & Tone", row.voiceGuide.trim());
  }
  const colors = row.colorTokens as BrandColorTokens | null;
  if (colors) {
    const parts: string[] = [];
    if (colors.primary) parts.push(`primary=${colors.primary}`);
    if (colors.secondary) parts.push(`secondary=${colors.secondary}`);
    if (colors.accent) parts.push(`accent=${colors.accent}`);
    if (parts.length) lines.push("", `Colors: ${parts.join(", ")}`);
  }
  const fonts = row.fontStack as BrandFontStack | null;
  if (fonts && (fonts.display || fonts.body || fonts.mono)) {
    const parts: string[] = [];
    if (fonts.display) parts.push(`display=${fonts.display}`);
    if (fonts.body) parts.push(`body=${fonts.body}`);
    if (fonts.mono) parts.push(`mono=${fonts.mono}`);
    lines.push(`Fonts: ${parts.join(", ")}`);
  }
  const doNot = (row.doNotJson as string[] | null) ?? [];
  if (doNot.length) {
    lines.push("", "### Do NOT");
    for (const item of doNot) lines.push(`- ${item}`);
  }
  return lines.join("\n");
}

export function registerBrandKitHandlers(): void {
  handle("brand-kit:list", async (): Promise<BrandKitDto[]> => {
    const rows = await db
      .select()
      .from(brandKits)
      .orderBy(desc(brandKits.isDefault), desc(brandKits.updatedAt));
    return rows.map(toDto);
  });

  handle(
    "brand-kit:get",
    async (_e, args: { id: number }): Promise<BrandKitDto | null> => {
      if (!args || typeof args.id !== "number") {
        throw new Error("brand-kit: id is required");
      }
      const [row] = await db
        .select()
        .from(brandKits)
        .where(eq(brandKits.id, args.id))
        .limit(1);
      return row ? toDto(row) : null;
    },
  );

  handle(
    "brand-kit:create",
    async (_e, input: BrandKitCreateInput): Promise<BrandKitDto> => {
      const name = validateName(input?.name);
      const now = new Date();
      const [row] = await db
        .insert(brandKits)
        .values({
          name,
          description: input.description ?? null,
          logoUrl: input.logoUrl ?? null,
          wordmarkUrl: input.wordmarkUrl ?? null,
          colorTokens: input.colorTokens ?? null,
          fontStack: input.fontStack ?? null,
          voiceGuide: input.voiceGuide ?? null,
          doNotJson: input.doNot ?? null,
          tagline: input.tagline ?? null,
          isDefault: input.isDefault ?? false,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      if (!row) throw new Error("brand-kit: insert returned no row");
      if (row.isDefault) await clearDefaultsExcept(row.id);
      return toDto(row);
    },
  );

  handle(
    "brand-kit:update",
    async (
      _e,
      args: { id: number; updates: BrandKitUpdateInput },
    ): Promise<BrandKitDto> => {
      if (!args || typeof args.id !== "number") {
        throw new Error("brand-kit: id is required");
      }
      const updates = args.updates ?? {};
      const patch: Partial<typeof brandKits.$inferInsert> = {
        updatedAt: new Date(),
      };
      if (updates.name !== undefined) patch.name = validateName(updates.name);
      if (updates.description !== undefined) patch.description = updates.description;
      if (updates.logoUrl !== undefined) patch.logoUrl = updates.logoUrl;
      if (updates.wordmarkUrl !== undefined) patch.wordmarkUrl = updates.wordmarkUrl;
      if (updates.colorTokens !== undefined) patch.colorTokens = updates.colorTokens;
      if (updates.fontStack !== undefined) patch.fontStack = updates.fontStack;
      if (updates.voiceGuide !== undefined) patch.voiceGuide = updates.voiceGuide;
      if (updates.doNot !== undefined) patch.doNotJson = updates.doNot;
      if (updates.tagline !== undefined) patch.tagline = updates.tagline;
      if (updates.isDefault !== undefined) patch.isDefault = updates.isDefault;

      const [row] = await db
        .update(brandKits)
        .set(patch)
        .where(eq(brandKits.id, args.id))
        .returning();
      if (!row) throw new Error(`brand-kit: id ${args.id} not found`);
      if (patch.isDefault) await clearDefaultsExcept(row.id);
      return toDto(row);
    },
  );

  handle(
    "brand-kit:delete",
    async (_e, args: { id: number }): Promise<{ deleted: number }> => {
      if (!args || typeof args.id !== "number") {
        throw new Error("brand-kit: id is required");
      }
      const result = await db
        .delete(brandKits)
        .where(eq(brandKits.id, args.id))
        .returning({ id: brandKits.id });
      // Best-effort asset cleanup.
      try {
        await fs.rm(brandKitAssetDir(args.id), { recursive: true, force: true });
      } catch (err) {
        logger.warn("asset dir cleanup failed", { id: args.id, err });
      }
      return { deleted: result.length };
    },
  );

  handle(
    "brand-kit:upload-asset",
    async (
      _e,
      args: BrandKitUploadInput,
    ): Promise<{ destPath: string; field: "logoUrl" | "wordmarkUrl" }> => {
      if (!args || typeof args.brandKitId !== "number") {
        throw new Error("brand-kit: brandKitId is required");
      }
      if (typeof args.sourcePath !== "string" || args.sourcePath.length === 0) {
        throw new Error("brand-kit: sourcePath is required");
      }
      if (args.slot !== "logo" && args.slot !== "wordmark") {
        throw new Error("brand-kit: slot must be 'logo' or 'wordmark'");
      }

      const [existing] = await db
        .select({ id: brandKits.id })
        .from(brandKits)
        .where(eq(brandKits.id, args.brandKitId))
        .limit(1);
      if (!existing) {
        throw new Error(`brand-kit: id ${args.brandKitId} not found`);
      }

      const ext = path.extname(args.sourcePath) || ".png";
      const dir = brandKitAssetDir(args.brandKitId);
      await fs.mkdir(dir, { recursive: true });
      const destPath = path.join(dir, `${args.slot}${ext}`);
      await fs.copyFile(args.sourcePath, destPath);

      const field: "logoUrl" | "wordmarkUrl" =
        args.slot === "logo" ? "logoUrl" : "wordmarkUrl";
      await db
        .update(brandKits)
        .set({ [field]: destPath, updatedAt: new Date() })
        .where(eq(brandKits.id, args.brandKitId));

      return { destPath, field };
    },
  );

  handle(
    "brand-kit:render-for-agent",
    async (_e, args: { agentId: number }): Promise<{ block: string }> => {
      if (!args || typeof args.agentId !== "number") {
        throw new Error("brand-kit: agentId is required");
      }
      const [row] = await db
        .select({ brandKitId: agents.brandKitId })
        .from(agents)
        .where(eq(agents.id, args.agentId))
        .limit(1);
      const block = await renderBrandKitBlock(row?.brandKitId ?? null);
      return { block };
    },
  );
}
