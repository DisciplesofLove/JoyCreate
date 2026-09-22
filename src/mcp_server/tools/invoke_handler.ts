/**
 * Shared bridge from an MCP tool to a registered IPC handler.
 *
 * Why this exists rather than `require("@/ipc/handlers/…")`:
 *
 * The tool modules used to pull handler functions in with a dynamic
 * `require()` on an alias path. Two things were wrong with that, and the
 * second hid the first. Vite does not rewrite alias specifiers inside a
 * dynamic `require`, so in the bundled main process every one of those calls
 * threw `Cannot find module '@/ipc/handlers/…'` — including for the two
 * modules that did export what was being asked for. And underneath that, the
 * named exports mostly did not exist anyway: handlers register themselves via
 * `ipcMain.handle` and are never exported as functions.
 *
 * Both problems disappear by going through the registry Electron already
 * keeps. `ipcMain._invokeHandlers` is the same map `ipcMain.handle` writes to,
 * so a channel that the app registered at boot is reachable here with no
 * module resolution at all — which is exactly why the marketplace tools that
 * used this pattern kept working while the rest silently failed.
 */

import { ipcMain } from "electron";

/**
 * Call a registered IPC handler by channel.
 *
 * Throws when the channel is not registered. Callers should let that surface
 * as an MCP error rather than folding it into a success payload — an agent
 * reading `{ error: "..." }` out of a successful result treats it as data.
 */
export async function invokeHandler(
  channel: string,
  ...args: unknown[]
): Promise<any> {
  const handler = (ipcMain as any)._invokeHandlers?.get(channel);
  if (!handler) {
    throw new Error(
      `IPC handler not found: ${channel}. Handlers must be registered before the MCP server starts.`,
    );
  }
  return handler({ sender: { id: -1 } }, ...args);
}

/** An MCP error result — distinct from a success payload describing a failure. */
export function toolError(message: string) {
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: message }],
  };
}

/** A successful MCP result carrying JSON. */
export function toolOk(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

/** Run a tool body, converting any throw into a proper MCP error. */
export async function runTool(
  label: string,
  fn: () => Promise<unknown>,
): Promise<ReturnType<typeof toolOk> | ReturnType<typeof toolError>> {
  try {
    return toolOk(await fn());
  } catch (err: any) {
    return toolError(`${label} failed: ${err?.message ?? String(err)}`);
  }
}
