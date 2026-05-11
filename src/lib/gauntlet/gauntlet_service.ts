/**
 * GauntletService — orchestrates the four-stage Left Gauntlet pipeline:
 *
 *   1. Infiltrate — Electron BrowserWindow loads target, jitters, captures
 *      cookies + a screenshot.
 *   2. Extract    — hosted Firecrawl turns the rendered DOM into Markdown,
 *      using the captured Cookie header so logged-in scrapes work.
 *   3. Sanitize   — Whitehat verifier strips hidden payloads + asks Ollama
 *      for a hijack probability. Hard-fails on threshold breach.
 *   4. Anchor     — clean Markdown is content-hashed (SHA-256) and persisted
 *      to disk; the hash doubles as a deterministic "CID-ish" id the rest
 *      of the app can address.
 *
 * Persists a `gauntlet_runs` row + per-stage `gauntlet_audit` entries.
 */

import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import log from "electron-log";
import { getDb } from "@/db";
import { gauntletRuns, gauntletAudit, gauntletSessions } from "@/db/schema";
import { getUserDataPath } from "@/paths/paths";
import { browserPool, type BrowserSlot } from "./browser_pool";
import { scrapeWithFirecrawl } from "./firecrawl_client";
import { verifyMarkdown } from "./whitehat_verifier";
import { saveCookieJar } from "./session_vault";
import {
  GauntletError,
  type GauntletProgressEvent,
  type GauntletRunInput,
  type GauntletRunResult,
  type GauntletStage,
} from "./types";

const logger = log.scope("gauntlet_service");

export type ProgressSink = (evt: GauntletProgressEvent) => void;

/** Cancellation registry — runId → AbortController. */
const cancellations = new Map<string, AbortController>();

export function cancelRun(runId: string): boolean {
  const ctrl = cancellations.get(runId);
  if (!ctrl) return false;
  ctrl.abort();
  return true;
}

function newRunId(): string {
  return `gnt_${Date.now().toString(36)}_${crypto
    .randomBytes(4)
    .toString("hex")}`;
}

function emit(
  sink: ProgressSink | undefined,
  runId: string,
  stage: GauntletStage,
  progress: number,
  message: string,
): void {
  if (!sink) return;
  sink({ runId, stage, progress, message, timestamp: Date.now() });
}

async function audit(
  runId: string,
  stage: GauntletStage | "verifier",
  decision: "allow" | "deny" | "strip",
  reason: string | null,
  score: number | null,
): Promise<void> {
  try {
    const db = await getDb();
    await db.insert(gauntletAudit).values({
      runId,
      stage,
      decision,
      reason: reason ?? null,
      score: score ?? null,
    });
  } catch (err) {
    logger.warn("audit insert failed", err);
  }
}

async function persistMarkdown(
  runId: string,
  markdown: string,
): Promise<{ hash: string; filePath: string }> {
  const hash = crypto.createHash("sha256").update(markdown, "utf8").digest("hex");
  const dir = path.join(getUserDataPath(), "gauntlet", "scrapes");
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${hash}.md`);
  // Only write if not already present — markdown is content-addressed.
  try {
    await fs.access(filePath);
  } catch {
    await fs.writeFile(filePath, markdown, "utf8");
  }
  return { hash, filePath };
}

async function bumpSession(sessionId: string): Promise<void> {
  try {
    const db = await getDb();
    await db
      .update(gauntletSessions)
      .set({ lastUsedAt: new Date() })
      .where(eq(gauntletSessions.id, sessionId));
  } catch (err) {
    logger.warn("bumpSession failed", err);
  }
}

export async function executeGauntletRun(
  input: GauntletRunInput,
  onProgress?: ProgressSink,
): Promise<GauntletRunResult> {
  const runId = newRunId();
  const started = Date.now();
  const ctrl = new AbortController();
  cancellations.set(runId, ctrl);

  // Insert the run row up front so the UI can poll.
  const db = await getDb();
  await db.insert(gauntletRuns).values({
    runId,
    blueprintId: input.blueprintId ?? null,
    targetUrl: input.targetUrl,
    intent: input.intentText,
    status: "running",
    sessionId: input.sessionId ?? null,
  });

  let slot: BrowserSlot | null = null;
  let screenshotPath: string | null = null;

  const fail = async (
    code: string,
    message: string,
  ): Promise<GauntletRunResult> => {
    const durationMs = Date.now() - started;
    await db
      .update(gauntletRuns)
      .set({
        status: code === "INTEGRITY_VIOLATION" ? "denied" : "failed",
        errorCode: code,
        errorMessage: message,
        durationMs,
        completedAt: new Date(),
      })
      .where(eq(gauntletRuns.runId, runId));
    return {
      runId,
      status: code === "INTEGRITY_VIOLATION" ? "denied" : "failed",
      durationMs,
      errorCode: code,
      errorMessage: message,
      screenshotPath: screenshotPath ?? undefined,
    };
  };

  try {
    // ─── Stage 1: Infiltrate ───────────────────────────────────────────
    emit(onProgress, runId, "infiltrate", 0.05, "Launching browser…");
    slot = await browserPool.acquire(input.sessionId);
    if (ctrl.signal.aborted) throw new GauntletError("CANCELLED", "cancelled");

    const { window, partition } = slot;
    emit(
      onProgress,
      runId,
      "infiltrate",
      0.2,
      `Navigating to ${input.targetUrl}`,
    );

    await window.loadURL(input.targetUrl);

    // Human-like jitter — small mouse-position events + scroll bursts.
    try {
      await window.webContents.executeJavaScript(
        `(async () => {
           const sleep = (n) => new Promise(r => setTimeout(r, n));
           const ev = (x, y) => window.dispatchEvent(
             new MouseEvent('mousemove', { clientX: x, clientY: y, bubbles: true })
           );
           ev(20, 20); await sleep(120);
           ev(220, 180); await sleep(180);
           window.scrollBy(0, Math.floor(window.innerHeight * 0.6));
           await sleep(300);
           window.scrollBy(0, Math.floor(window.innerHeight * 0.7));
         })();`,
        true,
      );
    } catch (err) {
      logger.debug("jitter eval failed (non-fatal)", err);
    }

    if (ctrl.signal.aborted) throw new GauntletError("CANCELLED", "cancelled");

    // Capture screenshot.
    try {
      const img = await window.webContents.capturePage();
      const shotsDir = path.join(getUserDataPath(), "gauntlet", "runs");
      await fs.mkdir(shotsDir, { recursive: true });
      screenshotPath = path.join(shotsDir, `${runId}.png`);
      await fs.writeFile(screenshotPath, img.toPNG());
    } catch (err) {
      logger.warn("screenshot failed", err);
    }

    // Capture cookies for Firecrawl + persist if sessionId set.
    let cookieHeader: string | undefined;
    try {
      const cookies = await window.webContents.session.cookies.get({
        url: input.targetUrl,
      });
      if (cookies.length > 0) {
        cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
      }
      if (input.sessionId) {
        const allCookies = await window.webContents.session.cookies.get({});
        await saveCookieJar(input.sessionId, allCookies);
        await bumpSession(input.sessionId);
      }
    } catch (err) {
      logger.warn("cookie capture failed", err);
    }

    await audit(runId, "infiltrate", "allow", `partition=${partition}`, null);

    // ─── Stage 2: Extract ─────────────────────────────────────────────
    emit(onProgress, runId, "extract", 0.4, "Firecrawl scraping…");
    if (ctrl.signal.aborted) throw new GauntletError("CANCELLED", "cancelled");
    const scrape = await scrapeWithFirecrawl(input.targetUrl, cookieHeader);
    await audit(
      runId,
      "extract",
      "allow",
      `bytes=${scrape.markdown.length}`,
      null,
    );

    // ─── Stage 3: Sanitize ────────────────────────────────────────────
    emit(onProgress, runId, "sanitize", 0.65, "Whitehat verifying…");
    if (ctrl.signal.aborted) throw new GauntletError("CANCELLED", "cancelled");
    const verdict = await verifyMarkdown(scrape.markdown, input.intentText, {
      hijackThreshold: input.hijackThreshold,
      model: input.verifierModel,
    });
    if (verdict.strippedHidden) {
      await audit(
        runId,
        "sanitize",
        "strip",
        "hidden patterns removed",
        verdict.score,
      );
    }
    if (!verdict.safe) {
      await audit(
        runId,
        "sanitize",
        "deny",
        verdict.reason,
        verdict.score,
      );
      throw new GauntletError(
        "INTEGRITY_VIOLATION",
        `Whitehat denied scrape (hijack=${verdict.hijackProbability.toFixed(
          3,
        )}): ${verdict.reason}`,
      );
    }
    await audit(runId, "sanitize", "allow", verdict.reason, verdict.score);

    // ─── Stage 4: Anchor ──────────────────────────────────────────────
    emit(onProgress, runId, "anchor", 0.9, "Anchoring clean markdown…");
    const { hash, filePath } = await persistMarkdown(runId, scrape.markdown);
    await audit(runId, "anchor", "allow", `sha256=${hash}`, verdict.score);

    const durationMs = Date.now() - started;
    await db
      .update(gauntletRuns)
      .set({
        status: "succeeded",
        markdownCid: hash,
        markdownPath: filePath,
        integrityScore: verdict.score,
        durationMs,
        screenshotPath: screenshotPath ?? null,
        completedAt: new Date(),
      })
      .where(eq(gauntletRuns.runId, runId));

    emit(onProgress, runId, "anchor", 1, "Complete.");

    return {
      runId,
      status: "succeeded",
      markdownCid: hash,
      markdownPath: filePath,
      integrityScore: verdict.score,
      durationMs,
      screenshotPath: screenshotPath ?? undefined,
    };
  } catch (err) {
    const code =
      err instanceof GauntletError ? err.code : "INTERNAL_ERROR";
    const message = (err as Error).message ?? String(err);
    logger.warn(`gauntlet run ${runId} failed`, code, message);
    return await fail(code, message);
  } finally {
    cancellations.delete(runId);
    if (slot) {
      await slot.release();
    }
  }
}
