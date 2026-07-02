/**
 * In-memory ring buffer of recent runtime output (stdout/stderr) for each
 * running app's dev server. This lets the local agent's `read_logs` tool read
 * the app's actual runtime logs — build/HMR errors, server exceptions, console
 * output — to debug issues, rather than only running static type checks.
 *
 * The buffer is capped per app so it can never grow unbounded. Entries are
 * appended by the app runner (see app_handlers.ts) and cleared when the app is
 * (re)started.
 */

export type AppLogType = "stdout" | "stderr" | "info";

export interface AppLogEntry {
  type: AppLogType;
  message: string;
  /** Unix epoch milliseconds when the line was captured. */
  timestamp: number;
}

/** Maximum number of log entries retained per app. Oldest are dropped first. */
const MAX_ENTRIES_PER_APP = 500;

const buffers = new Map<number, AppLogEntry[]>();

/** Append a log line for an app, trimming the buffer to the cap. */
export function appendAppLog(
  appId: number,
  type: AppLogType,
  message: string,
): void {
  const trimmed = message.trimEnd();
  if (!trimmed) return;

  let buf = buffers.get(appId);
  if (!buf) {
    buf = [];
    buffers.set(appId, buf);
  }
  buf.push({ type, message: trimmed, timestamp: Date.now() });

  // Drop oldest entries beyond the cap.
  if (buf.length > MAX_ENTRIES_PER_APP) {
    buf.splice(0, buf.length - MAX_ENTRIES_PER_APP);
  }
}

export interface GetAppLogsOptions {
  /** Only return the most recent N entries. */
  limit?: number;
  /** Only return stderr entries (useful for error triage). */
  errorsOnly?: boolean;
  /** Case-insensitive substring the message must contain. */
  filter?: string;
}

/** Read recent log entries for an app (most recent last). */
export function getAppLogs(
  appId: number,
  options: GetAppLogsOptions = {},
): AppLogEntry[] {
  const buf = buffers.get(appId) ?? [];
  let entries = buf;

  if (options.errorsOnly) {
    entries = entries.filter((e) => e.type === "stderr");
  }
  if (options.filter) {
    const needle = options.filter.toLowerCase();
    entries = entries.filter((e) =>
      e.message.toLowerCase().includes(needle),
    );
  }
  if (options.limit && options.limit > 0 && entries.length > options.limit) {
    entries = entries.slice(entries.length - options.limit);
  }
  return entries;
}

/** Remove all buffered logs for an app (called on start/restart). */
export function clearAppLogs(appId: number): void {
  buffers.delete(appId);
}
