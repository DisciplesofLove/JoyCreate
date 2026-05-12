/**
 * Best-effort mirror of audit-log rows into a per-scope hypercore so peers
 * can replicate the audit trail. Never throws — audit logging must succeed
 * locally even when the hyper layer is down.
 *
 * Usage:
 *
 *   await db.insert(jcnAuditLog).values(row);
 *   void mirrorAuditEvent("jcn-audit", row.actorDid ?? "anon", row);
 */

import log from "electron-log";

const logger = log.scope("hyper_audit_mirror");

export function mirrorAuditEvent(
  scope:
    | "whitehat-anchor"
    | "ssi-anchor"
    | "vault-audit"
    | "jcn-audit"
    | "slash-records",
  subjectId: string,
  entry: unknown,
): void {
  void (async () => {
    try {
      const { HyperLogStore } = await import("./hyper_log_store");
      const store = new HyperLogStore(scope, subjectId || "global");
      await store.tryAppend(entry);
    } catch (err) {
      logger.warn(`mirror ${scope} failed`, err);
    }
  })();
}
