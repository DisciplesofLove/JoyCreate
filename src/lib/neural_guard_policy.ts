/**
 * Neural Guard policy engine.
 *
 * The signature check in `neural_guard.verifyIntent` proves WHO is asking;
 * this module decides WHETHER they are allowed to. Policies are registered
 * per IPC channel and consulted by `assertIntent` after the cryptographic
 * check passes.
 *
 * Defaults (Phase 3 rollout, see /memories/session/plan.md):
 *   - Default action is `allow` so existing handlers keep working while
 *     we migrate the renderer to call `signAndInvoke`.
 *   - Once every Priority-1/2 handler is guarded, flip the default to
 *     `deny` so any unguarded channel fails closed.
 *
 * Override at boot via env var `JOY_NEURAL_GUARD_DEFAULT=deny|allow`.
 */

export type PolicyAction = "allow" | "deny";

export interface PolicyDecision {
  ok: boolean;
  /** Reason when `ok` is false. */
  reason?: string;
}

export type PolicyPredicate = (
  channel: string,
  agentWallet: string | undefined,
) => PolicyDecision;

interface ChannelPolicy {
  action: PolicyAction;
  predicate?: PolicyPredicate;
}

const channelPolicies = new Map<string, ChannelPolicy>();

// Phase 4: default flipped from "allow" to "deny". Unguarded channels now fail
// closed when accessed via the signed-intent envelope. Legacy positional calls
// still bypass evaluatePolicy entirely (gated by JOY_NEURAL_GUARD_ENFORCE).
// Override at boot via env: JOY_NEURAL_GUARD_DEFAULT=allow|deny.
let defaultAction: PolicyAction =
  (process?.env?.JOY_NEURAL_GUARD_DEFAULT as PolicyAction | undefined) ===
  "allow"
    ? "allow"
    : "deny";

/** Set the action used when no per-channel policy matches. */
export function setDefaultAction(action: PolicyAction): void {
  defaultAction = action;
}

/** Read the current default. Useful for tests / observability. */
export function getDefaultAction(): PolicyAction {
  return defaultAction;
}

/**
 * Register an `allow` policy for a channel. If `predicate` is supplied it
 * runs AFTER the cryptographic check and may further restrict access (rate
 * limit, allowlisted DID, max payload size, etc.).
 */
export function allow(channel: string, predicate?: PolicyPredicate): void {
  channelPolicies.set(channel, { action: "allow", predicate });
}

/**
 * Register a hard deny for a channel. The handler will be locked even with
 * a valid signature.
 */
export function deny(channel: string): void {
  channelPolicies.set(channel, { action: "deny" });
}

/** Test-only reset. Not exported via IPC. */
export function _resetPoliciesForTests(): void {
  channelPolicies.clear();
  defaultAction = "allow";
}

/**
 * Register the baseline allow-list for every channel that is guarded today.
 * Called once at boot from `registerIpcHandlers`. Without these entries, the
 * default-deny fallback would lock every signed-intent caller out of the app.
 *
 * Predicates may be added per-channel (rate limit, allowlist) — this is just
 * the scaffolding so callers don't trip the default-deny.
 */
export function registerDefaultPolicies(): void {
  const channels = [
    // Phase 3 — scraper_handlers
    "scraper:config:save",
    "scraper:config:delete",
    "scraper:job:start",
    "scraper:job:cancel",
    "scraper:dataset:export",
    "scraper:dataset:delete",
    "scraper:dataset:create",
    "scraper:dataset:import",
    "scraper:quick-scrape",
    // Phase 3 — data_scraping_handlers
    "scraping:scrape-to-dataset",
    "scraping:scrape-feed-to-dataset",
    "scraping:scrape-api",
    "scraping:extract-urls",
    // Phase 3 — celestia_blob_handlers
    "celestia:blob:submit",
    "celestia:blob:submit-json",
    "celestia:blob:submit-file",
    "celestia:config:update",
    "celestia:config:reset",
    // Phase 3 — agent_marketplace_handlers
    "agent:publish-to-marketplace",
    "agent:unpublish",
    "agent:update-listing",
    // Phase 3 — decentralized_deploy_handlers
    "decentralized:save-credentials",
    "decentralized:remove-credentials",
    "decentralized:deploy",
    // Phase 3 — nft_handlers
    "nft:chunk-asset",
    "nft:create-listing",
    "nft:bulk-create-listings",
    "nft:update-pricing",
    "nft:update-status",
    "nft:publish",
    "nft:bulk-publish",
    "nft:delete-listing",
    // Phase 3 — skill_handlers
    "skill:create",
    "skill:update",
    "skill:delete",
    "skill:execute",
    "skill:generate",
    "skill:auto-generate",
    "skill:attach-to-agent",
    "skill:detach-from-agent",
    "skill:publish",
    "skill:unpublish",
    "skill:import",
    "skill:bootstrap",
    "skill:learn",
    // Phase 3 — task_execution_handlers
    "task:create-task",
    "task:create-from-template",
    "task:cancel-task",
    "task:retry-task",
    "task:create-queue",
    "task:pause-queue",
    "task:resume-queue",
    "task:create-batch",
    // Phase 3 — libreoffice_handlers
    "libreoffice:create",
    "libreoffice:delete",
    "libreoffice:update-metadata",
    "libreoffice:export",
    "libreoffice:open",
    "libreoffice:download",
    "libreoffice:shutdown",
    "libreoffice:stream-generate",
    "libreoffice:update-content",
    "libreoffice:ai-assist",
    // Phase 3 — agent_workspace_handlers
    "agent:workspace:task:create",
    "agent:workspace:task:update",
    "agent:workspace:task:delete",
    "agent:workspace:task:execute",
    "agent:workspace:knowledge:add",
    "agent:workspace:knowledge:update",
    "agent:workspace:knowledge:delete",
    "agent:workspace:knowledge:sync",
    // Phase 4 — auto_deploy_handlers
    "deploy:auto-deploy",
    // Phase 4 — services_handlers
    "services:start",
    "services:stop",
    "services:restart",
    "services:start:all",
    "services:stop:all",
    // Phase 4 — shell_handler
    "open-external-url",
    "show-item-in-folder",
    // Phase 4 — agent_export_handlers
    "agent:export:json",
    "agent:export:standalone",
    "agent:export:docker",
    "agent:export:web-chat",
    "agent:export:embed-snippet",
    // Phase 4 — autonomous_agent_production_handlers
    "autonomous-prod:initialize",
    "autonomous-prod:shutdown",
    "autonomous-prod:create-schedule",
    "autonomous-prod:request-approval",
    "autonomous-prod:respond-approval",
    "autonomous-prod:create-notification",
    "autonomous-prod:mark-notification-read",
    "autonomous-prod:record-quota-usage",
    "autonomous-prod:add-knowledge-node",
    "autonomous-prod:add-knowledge-edge",
    "autonomous-prod:record-event",
    "autonomous-prod:create-backup",
    // Sovereign Blueprint Engine
    "blueprint:run",
    "blueprint:cancel",
  ];
  for (const c of channels) allow(c);
}

/**
 * Decide whether `(channel, agentWallet)` may execute. Called by
 * `neural_guard.assertIntent` after signature verification.
 */
export function evaluatePolicy(
  channel: string,
  agentWallet: string | undefined,
): PolicyDecision {
  const policy = channelPolicies.get(channel);
  if (!policy) {
    if (defaultAction === "deny") {
      return { ok: false, reason: `no policy for channel ${channel}` };
    }
    return { ok: true };
  }
  if (policy.action === "deny") {
    return { ok: false, reason: `channel ${channel} is denied by policy` };
  }
  if (policy.predicate) {
    return policy.predicate(channel, agentWallet);
  }
  return { ok: true };
}

// ── reusable predicates ─────────────────────────────────────────────────────

/**
 * Allowlist of EVM addresses (lowercase). Use with `allow(channel, allowOnly([...]))`.
 */
export function allowOnly(addresses: string[]): PolicyPredicate {
  const set = new Set(addresses.map((a) => a.toLowerCase()));
  return (channel, agentWallet) => {
    if (!agentWallet || !set.has(agentWallet.toLowerCase())) {
      return { ok: false, reason: `wallet not on allowlist for ${channel}` };
    }
    return { ok: true };
  };
}

/**
 * Token-bucket rate limit, evaluated per `(channel, agentWallet)`. Defaults
 * to 60 calls/minute per wallet — enough for normal interactive use, low
 * enough to throttle a runaway agent.
 */
export function rateLimit(
  perMinute = 60,
): PolicyPredicate {
  const buckets = new Map<string, { tokens: number; refilledAt: number }>();
  const refillIntervalMs = 60_000;

  return (channel, agentWallet) => {
    const key = `${channel}::${(agentWallet ?? "anon").toLowerCase()}`;
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { tokens: perMinute, refilledAt: now };
      buckets.set(key, bucket);
    }
    if (now - bucket.refilledAt >= refillIntervalMs) {
      bucket.tokens = perMinute;
      bucket.refilledAt = now;
    }
    if (bucket.tokens <= 0) {
      return {
        ok: false,
        reason: `rate limit exceeded (${perMinute}/min) for ${key}`,
      };
    }
    bucket.tokens -= 1;
    return { ok: true };
  };
}

/** Compose multiple predicates (AND). First failure wins. */
export function all(...preds: PolicyPredicate[]): PolicyPredicate {
  return (channel, agentWallet) => {
    for (const p of preds) {
      const r = p(channel, agentWallet);
      if (!r.ok) return r;
    }
    return { ok: true };
  };
}
