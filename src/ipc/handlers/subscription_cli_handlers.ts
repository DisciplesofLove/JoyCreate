/**
 * Subscription CLI IPC handlers.
 *
 * Lets the settings UI answer three questions: which vendor CLIs are installed,
 * whether the user is signed in to them, and — the only one that really matters
 * — whether a prompt actually comes back. All handlers throw on error, per the
 * repo convention: reporting "connected" for a plan that is expired or out of
 * quota is precisely the lie this feature must not tell.
 */

import { shell } from "electron";
import log from "electron-log";

import { createLoggedHandler } from "./safe_handle";
import {
  detectSubscriptionCli,
  detectSubscriptionClis,
  invalidateCliDetectionCache,
} from "@/lib/subscription_cli/cli_detector";
import { testSubscriptionCli } from "@/lib/subscription_cli/cli_runner";
import { getSubscriptionCli, SUBSCRIPTION_CLIS } from "@/lib/subscription_cli/cli_registry";

const logger = log.scope("subscription_cli_handlers");
const handle = createLoggedHandler(logger);

export function registerSubscriptionCliHandlers(): void {
  /** Static catalog — safe to call before anything is installed. */
  handle("subscription-cli:list", async () =>
    SUBSCRIPTION_CLIS.map((cli) => ({
      id: cli.id,
      label: cli.label,
      vendor: cli.vendor,
      subscription: cli.subscription,
      loginCommand: cli.loginCommand,
      installCommand: cli.installCommand,
      docsUrl: cli.docsUrl,
      models: cli.models,
    })),
  );

  /** What is actually on this machine. `force` skips the 15s cache. */
  handle("subscription-cli:detect", async (_, params?: { force?: boolean }) =>
    detectSubscriptionClis({ force: params?.force }),
  );

  handle("subscription-cli:status", async (_, params: { id: string }) => {
    if (!params?.id) throw new Error("A CLI id is required");
    const detection = await detectSubscriptionCli(params.id);
    if (!detection) throw new Error(`Unknown subscription CLI: ${params.id}`);
    return detection;
  });

  /**
   * Send a real prompt through the CLI.
   *
   * This is the only check worth trusting. A binary on disk and a credential
   * file both existing proves the user logged in once, not that the session is
   * still valid or that the plan has quota left.
   */
  handle(
    "subscription-cli:test",
    async (_, params: { id: string; model?: string }) => {
      if (!params?.id) throw new Error("A CLI id is required");
      const def = getSubscriptionCli(params.id);
      if (!def) throw new Error(`Unknown subscription CLI: ${params.id}`);
      return await testSubscriptionCli(params.id, params.model);
    },
  );

  /** Re-scan after the user installs or signs in without restarting the app. */
  handle("subscription-cli:refresh", async () => {
    invalidateCliDetectionCache();
    return await detectSubscriptionClis({ force: true });
  });

  handle("subscription-cli:open-docs", async (_, params: { id: string }) => {
    const def = getSubscriptionCli(params?.id);
    if (!def) throw new Error(`Unknown subscription CLI: ${params?.id}`);
    await shell.openExternal(def.docsUrl);
    return { opened: def.docsUrl };
  });
}
