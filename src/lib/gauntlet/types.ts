/**
 * Left Gauntlet — shared types for the Puppeteer + Firecrawl + Whitehat
 * pipeline. Lives in `src/lib/gauntlet/`.
 */

export type GauntletStage =
  | "infiltrate"
  | "extract"
  | "sanitize"
  | "anchor";

export interface GauntletRunInput {
  /** Absolute URL to scrape. */
  targetUrl: string;
  /** Plain-language description of what the user wants extracted. */
  intentText: string;
  /** Optional Blueprint id for audit anchoring. */
  blueprintId?: string;
  /** Optional saved-session id whose cookies/localStorage should be restored. */
  sessionId?: string;
  /**
   * Hijack-probability threshold used by the Whitehat verifier.
   * Anything strictly above this is rejected. Default 0.05.
   */
  hijackThreshold?: number;
  /**
   * Per-run override of the Ollama model to use for verification.
   * Defaults to the value in app settings (or `llama3-guardian`).
   */
  verifierModel?: string;
}

export type GauntletRunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "denied"
  | "cancelled";

export interface GauntletProgressEvent {
  runId: string;
  stage: GauntletStage;
  progress: number;
  message: string;
  timestamp: number;
}

export interface GauntletRunResult {
  runId: string;
  status: GauntletRunStatus;
  markdownCid?: string;
  markdownPath?: string;
  integrityScore?: number;
  durationMs: number;
  screenshotPath?: string;
  errorCode?: string;
  errorMessage?: string;
}

export interface GauntletSessionMeta {
  id: string;
  label: string;
  originPattern: string;
  lastUsedAt: number | null;
  createdAt: number;
}

export interface GauntletAuditRow {
  id: number;
  runId: string;
  stage: GauntletStage | "verifier";
  decision: "allow" | "deny" | "strip";
  reason: string | null;
  score: number | null;
  createdAt: number;
}

/** Stable error codes thrown by the Gauntlet pipeline. */
export const GauntletErrorCodes = {
  FIRECRAWL_KEY_MISSING: "FIRECRAWL_KEY_MISSING",
  FIRECRAWL_FAILED: "FIRECRAWL_FAILED",
  WHITEHAT_OLLAMA_UNAVAILABLE: "WHITEHAT_OLLAMA_UNAVAILABLE",
  INTEGRITY_VIOLATION: "INTEGRITY_VIOLATION",
  BROWSER_LAUNCH_FAILED: "BROWSER_LAUNCH_FAILED",
  CANCELLED: "CANCELLED",
  POOL_EXHAUSTED: "POOL_EXHAUSTED",
} as const;

export type GauntletErrorCode =
  (typeof GauntletErrorCodes)[keyof typeof GauntletErrorCodes];

export class GauntletError extends Error {
  constructor(
    public readonly code: GauntletErrorCode,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "GauntletError";
  }
}
