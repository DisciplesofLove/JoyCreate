/**
 * Stub IPC Handlers
 *
 * Safe no-op handlers for IPC channels that have renderer-side callers
 * (in pages/components/clients) but where the corresponding main-side
 * service has not yet been implemented. Returning safe defaults
 * (empty arrays for list operations, null for get operations,
 * { ok: false, stub: true } for mutations) prevents the UI from
 * crashing while still surfacing in dev tools that the feature
 * is not yet wired up.
 *
 * As real implementations are added, REMOVE the corresponding entries
 * from STUB_CHANNELS below and register the real handler in ipc_host.
 *
 * Tracked clusters:
 *   - openclaw:sessions/subagents/cron/celestia (AgentCommandCenter)
 *   - joycreate:agents:*       (AgentCommandCenter)
 *   - version-control:*        (data_studio_extended_client)
 *   - lineage:add-X / get-up / down / analyze (data_studio_extended_client)
 *   - pipeline:get-run-X, pipeline:cancel-run (data_studio_extended_client)
 *   - analytics:dataset-stats / global-stats (data_studio_extended_client)
 *   - report:generate / export / get-history (data_studio_extended_client)
 *   - dashboard:*              (data_studio_extended_client)
 *   - generation:list-jobs / save-template (data_studio_extended_client)
 */

import { ipcMain } from "electron";
import log from "electron-log";

const logger = log.scope("ipc-stub");

type StubBehavior = "list" | "get" | "mutation" | "void";

const STUB_CHANNELS: Array<{ channel: string; behavior: StubBehavior }> = [
  // Data Studio Extended — version control
  { channel: "version-control:initialize", behavior: "mutation" },
  { channel: "version-control:commit", behavior: "mutation" },
  { channel: "version-control:get-history", behavior: "list" },
  { channel: "version-control:create-branch", behavior: "mutation" },
  { channel: "version-control:switch-branch", behavior: "mutation" },
  { channel: "version-control:merge", behavior: "mutation" },
  { channel: "version-control:get-diff", behavior: "get" },
  { channel: "version-control:rollback", behavior: "mutation" },
  { channel: "version-control:create-tag", behavior: "mutation" },
  { channel: "version-control:get-timeline", behavior: "list" },

  // Data Studio Extended — lineage helpers
  { channel: "lineage:add-node", behavior: "mutation" },
  { channel: "lineage:add-edge", behavior: "mutation" },
  { channel: "lineage:get-upstream", behavior: "list" },
  { channel: "lineage:get-downstream", behavior: "list" },
  { channel: "lineage:analyze-impact", behavior: "get" },

  // Data Studio Extended — pipeline runs
  { channel: "pipeline:get-run-status", behavior: "get" },
  { channel: "pipeline:cancel-run", behavior: "mutation" },
  { channel: "pipeline:get-run-history", behavior: "list" },

  // Data Studio Extended — analytics & reports
  { channel: "analytics:dataset-stats", behavior: "get" },
  { channel: "analytics:global-stats", behavior: "get" },
  { channel: "report:generate", behavior: "mutation" },
  { channel: "report:export", behavior: "mutation" },
  { channel: "report:get-history", behavior: "list" },

  // Data Studio Extended — dashboards
  { channel: "dashboard:create", behavior: "mutation" },
  { channel: "dashboard:update", behavior: "mutation" },
  { channel: "dashboard:list", behavior: "list" },
  { channel: "dashboard:get-data", behavior: "get" },
];

function safeDefault(behavior: StubBehavior): unknown {
  switch (behavior) {
    case "list":
      return [];
    case "get":
      return null;
    case "mutation":
      return { ok: false, stub: true, message: "Not yet implemented" };
    case "void":
    default:
      return undefined;
  }
}

export function registerStubHandlers(): void {
  logger.info(`Registering ${STUB_CHANNELS.length} stub IPC handlers`);
  // Track which stub channels have already been logged this session so we
  // don't flood the console when a UI polls a stubbed endpoint on a timer.
  const warned = new Set<string>();
  for (const { channel, behavior } of STUB_CHANNELS) {
    ipcMain.handle(channel, async () => {
      if (!warned.has(channel)) {
        warned.add(channel);
        logger.warn(
          `stub invoked: ${channel} — no real handler registered (returning ${behavior} default). Further calls will be silent.`,
        );
      }
      return safeDefault(behavior);
    });
  }
}

/** Exported so preload can be kept in sync programmatically if desired. */
export const STUB_CHANNEL_NAMES = STUB_CHANNELS.map((c) => c.channel);
