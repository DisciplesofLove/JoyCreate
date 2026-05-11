/**
 * Higher-order wrapper that drops Neural Guard verification onto an
 * existing IPC handler with minimal noise at the call site.
 *
 * Before:
 *   ipcMain.handle("scraper:job:start", async (_, configId: string) => {
 *     // ... side-effecting work
 *   });
 *
 * After:
 *   ipcMain.handle(
 *     "scraper:job:start",
 *     guarded("scraper:job:start", async (_, configId: string) => {
 *       // ... side-effecting work
 *     }),
 *   );
 *
 * The wrapped handler accepts EITHER:
 *   - the new wrapped envelope `{ payload, signedIntent }` produced by
 *     `IpcClient.signAndInvoke` — verifies the intent and forwards
 *     `payload` as the FIRST positional argument
 *   - the legacy multi-positional shape (e.g. `(event, configId)` or
 *     `(event, datasetId, options)`) — emits a one-shot console warning
 *     per channel and forwards every positional arg unchanged
 *
 * Set `JOY_NEURAL_GUARD_ENFORCE=1` to fail closed on any legacy unsigned
 * call. When migrating multi-positional callers to `signAndInvoke`, bundle
 * every input into a single object payload (the handler will receive that
 * object as its first arg).
 */

import type { IpcMainInvokeEvent } from "electron";
import { assertIntent, type SignedIntent } from "@/lib/neural_guard";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyHandler = (event: IpcMainInvokeEvent, ...args: any[]) => any;

/**
 * Wrap a handler so the first thing it does is verify the signed intent.
 * The wrapped function preserves the original handler's return type.
 */
export function guarded<H extends AnyHandler>(
  channel: string,
  handler: H,
): (
  event: IpcMainInvokeEvent,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ...args: any[]
) => Promise<Awaited<ReturnType<H>>> {
  return async (event, ...args) => {
    const first = args[0];
    if (
      first !== null &&
      typeof first === "object" &&
      "payload" in (first as Record<string, unknown>) &&
      "signedIntent" in (first as Record<string, unknown>)
    ) {
      const wrapped = first as {
        payload: unknown;
        signedIntent: SignedIntent<unknown>;
      };
      assertIntent(channel, wrapped.payload, wrapped.signedIntent);
      // Wrapped envelope MUST contain every input in `payload`.
      return handler(event, wrapped.payload);
    }

    if (process.env.JOY_NEURAL_GUARD_ENFORCE === "1") {
      throw new Error(
        `neural-guard: refused unsigned legacy call to ${channel} (enforce=1)`,
      );
    }
    legacyWarn(channel);
    return handler(event, ...args);
  };
}

const legacyWarned = new Set<string>();
function legacyWarn(channel: string): void {
  if (legacyWarned.has(channel)) return;
  legacyWarned.add(channel);
  // eslint-disable-next-line no-console
  console.warn(
    `[neural-guard] unsigned legacy call to ${channel} — migrate caller to IpcClient.signAndInvoke / useGuardedMutation`,
  );
}
