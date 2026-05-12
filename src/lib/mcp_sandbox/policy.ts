/**
 * Whitehat MCP policy — central decision point invoked by the stdio proxy
 * before any `tools/call` is forwarded to the real MCP server.
 *
 * Order of evaluation:
 *   1. Static allowlist row in `whitehat_mcp_allowlist` matching
 *      (serverName, toolName, invocationHash).
 *   2. Hybrid interactive prompt: if the JoyCreate window is foregrounded
 *      AND a renderer is subscribed, fire `whitehat:mcp:pending` and await
 *      the user's response (Allow once / Allow always / Deny).
 *   3. Default deny.
 *
 * Every decision writes one row to `whitehat_mcp_audit`.
 */

import { eq, and, desc } from "drizzle-orm";
import log from "electron-log";
import { getDb } from "@/db";
import { whitehatMcpAllowlist, whitehatMcpAudit } from "@/db/schema";
import { computeInvocationHash, type McpInvocation } from "./hash";

const logger = log.scope("whitehat-mcp-policy");

export type PolicyDecision = "allow" | "deny";

export interface PolicyResult {
  decision: PolicyDecision;
  reason: string;
  invocationHash: string;
}

export interface PendingApproval {
  id: number;
  serverName: string;
  toolName: string;
  invocationHash: string;
  args: unknown;
  rpcId?: string | number | null;
  createdAt: number;
}

export type ApprovalChoice = "once" | "always" | "deny";

interface PendingEntry {
  approval: PendingApproval;
  resolve: (choice: ApprovalChoice) => void;
}

const pending = new Map<number, PendingEntry>();
let nextPendingId = 1;

type PendingListener = (entry: PendingApproval) => void;
const pendingListeners = new Set<PendingListener>();

/**
 * Subscribe to new pending approvals. Used by IPC handlers to forward the
 * event to the renderer. Returns an unsubscribe function.
 */
export function onPending(listener: PendingListener): () => void {
  pendingListeners.add(listener);
  return () => pendingListeners.delete(listener);
}

/** Snapshot of currently pending approvals for `mcp:list-pending`. */
export function listPending(): PendingApproval[] {
  return Array.from(pending.values()).map((p) => p.approval);
}

/**
 * Resolve a pending approval — called by the IPC `mcp:respond` handler when
 * the user clicks Allow once / Allow always / Deny.
 */
export function respondPending(id: number, choice: ApprovalChoice): boolean {
  const entry = pending.get(id);
  if (!entry) return false;
  pending.delete(id);
  entry.resolve(choice);
  return true;
}

/**
 * Configurable hook so the proxy can ask the host whether interactive
 * approval is currently possible (renderer attached, window foregrounded).
 * Defaults to `false` — strict-deny when running headless.
 */
let canPromptUser: () => boolean = () => false;
export function setInteractiveAvailability(fn: () => boolean): void {
  canPromptUser = fn;
}

/** Test/integration override. */
export function _resetForTests(): void {
  pending.clear();
  pendingListeners.clear();
  nextPendingId = 1;
  canPromptUser = () => false;
}

/**
 * Main entry point. Returns `{ decision, reason, invocationHash }`.
 * Always writes a row to `whitehat_mcp_audit`.
 */
export async function evaluate(
  inv: McpInvocation,
  rpcId?: string | number | null,
): Promise<PolicyResult> {
  const invocationHash = computeInvocationHash(inv);
  const db = getDb();

  // 1. Static allowlist
  try {
    const rows = await db
      .select()
      .from(whitehatMcpAllowlist)
      .where(
        and(
          eq(whitehatMcpAllowlist.serverName, inv.serverName),
          eq(whitehatMcpAllowlist.toolName, inv.toolName),
          eq(whitehatMcpAllowlist.invocationHash, invocationHash),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (row) {
      // Update last-used timestamp; revoke if `once`.
      if (row.scope === "once") {
        await db
          .delete(whitehatMcpAllowlist)
          .where(eq(whitehatMcpAllowlist.id, row.id));
      } else {
        await db
          .update(whitehatMcpAllowlist)
          .set({ lastUsedAt: new Date() })
          .where(eq(whitehatMcpAllowlist.id, row.id));
      }
      const result: PolicyResult = {
        decision: "allow",
        reason: `allowlist match (${row.scope})`,
        invocationHash,
      };
      await writeAudit(inv, invocationHash, "allow", result.reason, rpcId);
      return result;
    }
  } catch (err) {
    logger.error("allowlist lookup failed:", err);
  }

  // 2. Interactive prompt (hybrid mode)
  if (canPromptUser() && pendingListeners.size > 0) {
    const result = await promptUser(inv, invocationHash, rpcId);
    return result;
  }

  // 3. Default deny
  const result: PolicyResult = {
    decision: "deny",
    reason: "no allowlist entry and no interactive prompt available",
    invocationHash,
  };
  await writeAudit(inv, invocationHash, "deny", result.reason, rpcId);
  return result;
}

async function promptUser(
  inv: McpInvocation,
  invocationHash: string,
  rpcId: string | number | null | undefined,
): Promise<PolicyResult> {
  const db = getDb();
  const id = nextPendingId++;
  const approval: PendingApproval = {
    id,
    serverName: inv.serverName,
    toolName: inv.toolName,
    invocationHash,
    args: inv.args,
    rpcId: rpcId ?? null,
    createdAt: Math.floor(Date.now() / 1000),
  };

  await writeAudit(inv, invocationHash, "pending", "awaiting user", rpcId);

  const choice = await new Promise<ApprovalChoice>((resolve) => {
    pending.set(id, { approval, resolve });
    for (const listener of pendingListeners) {
      try {
        listener(approval);
      } catch (err) {
        logger.error("pendingListener threw:", err);
      }
    }
  });

  if (choice === "deny") {
    const result: PolicyResult = {
      decision: "deny",
      reason: "user denied",
      invocationHash,
    };
    await writeAudit(inv, invocationHash, "deny", result.reason, rpcId);
    return result;
  }

  // Persist approval
  try {
    await db.insert(whitehatMcpAllowlist).values({
      serverName: inv.serverName,
      toolName: inv.toolName,
      invocationHash,
      scope: choice,
      grantedBy: "user",
    });
  } catch (err) {
    // unique constraint is fine — entry already exists
    logger.warn("allowlist insert failed (may already exist):", err);
  }

  const result: PolicyResult = {
    decision: "allow",
    reason: `user approved (${choice})`,
    invocationHash,
  };
  await writeAudit(inv, invocationHash, "approved", result.reason, rpcId);
  return result;
}

async function writeAudit(
  inv: McpInvocation,
  invocationHash: string,
  decision: "allow" | "deny" | "pending" | "approved" | "revoked",
  reason: string,
  rpcId: string | number | null | undefined,
): Promise<void> {
  try {
    await getDb().insert(whitehatMcpAudit).values({
      serverName: inv.serverName,
      toolName: inv.toolName,
      invocationHash,
      argsJson: inv.args ?? null,
      decision,
      reason,
      rpcId: rpcId == null ? null : String(rpcId),
    });
    const { mirrorAuditEvent } = await import("@/lib/hyper/mirror_audit");
    mirrorAuditEvent("whitehat-anchor", inv.serverName, {
      serverName: inv.serverName,
      toolName: inv.toolName,
      invocationHash,
      decision,
      reason,
      at: new Date().toISOString(),
    });
  } catch (err) {
    logger.error("audit insert failed:", err);
  }
}

/** Read recent audit rows for the renderer. */
export async function listAudit(limit = 100): Promise<unknown[]> {
  const db = getDb();
  return db
    .select()
    .from(whitehatMcpAudit)
    .orderBy(desc(whitehatMcpAudit.createdAt))
    .limit(limit);
}

/** Read the active allowlist for the renderer. */
export async function listAllowlist(): Promise<unknown[]> {
  const db = getDb();
  return db
    .select()
    .from(whitehatMcpAllowlist)
    .orderBy(desc(whitehatMcpAllowlist.createdAt));
}

/** Revoke an allowlist entry by id. */
export async function revokeAllowlist(id: number): Promise<void> {
  const db = getDb();
  const rows = await db
    .select()
    .from(whitehatMcpAllowlist)
    .where(eq(whitehatMcpAllowlist.id, id))
    .limit(1);
  const row = rows[0];
  if (!row) throw new Error(`allowlist entry ${id} not found`);
  await db.delete(whitehatMcpAllowlist).where(eq(whitehatMcpAllowlist.id, id));
  await writeAudit(
    { serverName: row.serverName, toolName: row.toolName, args: null },
    row.invocationHash,
    "revoked",
    "user revoked",
    null,
  );
}
