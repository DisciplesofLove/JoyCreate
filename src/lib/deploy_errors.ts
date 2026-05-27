/**
 * Renderer-side parser for structured deploy errors thrown by
 * `src/ipc/handlers/vercel_handlers.ts` (`joyDeployError`).
 *
 * IPC flattens custom Error fields, so the handler packs metadata as JSON
 * inside `Error.message`. We parse it back here so the UI can render
 * actionable CTAs (Install Vercel GitHub App, Connect Vercel, etc.).
 */

export type JoyDeployErrorCode =
  | "vercel_token_missing"
  | "vercel_token_invalid"
  | "vercel_github_app_missing"
  | "vercel_project_name_taken"
  | "vercel_forbidden"
  | "vercel_not_found"
  | "github_not_connected"
  | "vercel_unknown";

export interface ParsedDeployError {
  code: JoyDeployErrorCode | "unknown";
  message: string;
  installUrl?: string;
  repo?: string;
  details?: string;
}

/**
 * Parse an error (string, Error, or unknown) thrown by the deploy IPC layer.
 * Returns a structured object even when the underlying error wasn't a
 * `joyDeployError` — falls back to `{ code: "unknown", message }`.
 */
export function parseDeployError(err: unknown): ParsedDeployError {
  const raw =
    err instanceof Error
      ? err.message
      : typeof err === "string"
        ? err
        : String(err ?? "");

  // Handlers prefix structured errors with `{"joy":true,...}`. Also
  // tolerate a wrapping "Error: " prefix from electron-log or IPC frames.
  const candidate = raw.replace(/^Error:\s*/i, "").trim();

  if (candidate.startsWith("{") && candidate.includes('"joy":true')) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && parsed.joy === true && typeof parsed.code === "string") {
        return {
          code: parsed.code,
          message: parsed.message || raw,
          installUrl: parsed.installUrl,
          repo: parsed.repo,
          details: parsed.details,
        };
      }
    } catch {
      // fall through
    }
  }

  return {
    code: "unknown",
    message: raw || "Deploy failed.",
  };
}
