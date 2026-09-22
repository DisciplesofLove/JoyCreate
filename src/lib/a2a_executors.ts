/**
 * Real executors for the A2A economy.
 *
 * `registerA2aExecutor` has existed since the economy was built and had zero
 * callers, so `resolveExecutor` always fell through to the echo executor. Every
 * invocation in the system therefore settled, paid the provider and updated its
 * reputation score for having returned the caller's own input back to them. The
 * money moved; no work did.
 *
 * This module supplies the missing half: a capability name maps to an IPC
 * channel the app already serves, and invoking a listing runs that handler.
 *
 * Routing through `invokeHandler` rather than importing the implementations is
 * deliberate — it is the same registry-based bridge the MCP tools use, so a
 * capability sold over A2A and the same capability driven by an MCP client run
 * the identical code path, and it is the one place a future policy check has to
 * be inserted to cover both.
 */

import log from "electron-log";

import { registerA2aExecutor } from "@/ipc/handlers/a2a_handlers";
import { invokeHandler } from "@/mcp_server/tools/invoke_handler";
import type { InvocationExecutor } from "@/lib/a2a_economy";
import {
  CAPABILITY_CHANNELS,
  isRealCapability,
} from "@/lib/a2a_capability_catalog";

const logger = log.scope("a2a_executors");

export { CAPABILITY_CHANNELS, isRealCapability };

/**
 * Some handlers report failure by returning `{ success: false, error }` rather
 * than throwing, in spite of the repo convention that handlers throw.
 *
 * That distinction decides whether the buyer keeps their money. `invokeContract`
 * only fails a contract when the executor throws, so a returned failure was
 * recorded as a completed invocation, moved the contract to DELIVERED, and paid
 * the provider in full on verification — observed live, with a document handler
 * that had errored on its own arguments. Converting it to a throw routes it
 * through the normal failure path, which refunds.
 */
function assertHandlerSucceeded(channel: string, result: unknown): void {
  if (!result || typeof result !== "object") return;
  const r = result as Record<string, unknown>;
  if (r.success === false) {
    throw new Error(
      `${channel} reported failure: ${String(r.error ?? "no reason given")}`,
    );
  }
}

function makeExecutor(capability: string, channel: string): InvocationExecutor {
  return async ({ input, contract, listing }) => {
    // The handler receives the invocation input verbatim. Contract identifiers
    // are passed alongside rather than merged in, so a handler that echoes its
    // params back cannot make an invocation look like it carried fields the
    // caller never sent.
    const output = await invokeHandler(channel, input ?? {});
    assertHandlerSucceeded(channel, output);

    return {
      output: {
        capability,
        channel,
        contractId: contract.id,
        listingId: listing.id,
        result: (output ?? null) as unknown,
      } as Record<string, unknown>,
      provider: "joycreate",
      model: channel,
    };
  };
}

let registered = false;

/**
 * Bind every catalogued capability. Safe to call more than once; the registry
 * is a Map keyed by capability, so a repeat call replaces rather than
 * duplicates, but the guard keeps the log honest.
 */
export function registerBuiltinA2aExecutors(): void {
  if (registered) return;
  for (const [capability, channel] of Object.entries(CAPABILITY_CHANNELS)) {
    registerA2aExecutor(capability, makeExecutor(capability, channel));
  }
  registered = true;
  logger.info(
    `registered ${Object.keys(CAPABILITY_CHANNELS).length} A2A capability executors`,
  );
}
