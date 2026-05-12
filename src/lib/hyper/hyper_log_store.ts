/**
 * HyperLogStore<T> — typed append-only-log adapter on top of HyperService.
 *
 * Each instance is bound to ONE (scope, subjectId) topic and serializes
 * domain events of type T to the underlying hypercore. Callers wire this in
 * AFTER they've persisted the row to SQLite — the returned `{seq, hashHex}`
 * should be stamped back on the row's `hyperSeq` / `hyperHash` columns.
 *
 * IMPORTANT: every method is best-effort. If the swarm isn't started yet
 * (feature flag off, init not complete, etc.) `tryAppend()` returns `null`
 * instead of throwing — callers shouldn't fail user-facing writes just
 * because the peer layer is offline. Use `append()` (throws) when you
 * explicitly require replication.
 */

import log from "electron-log";
import { getHyperService } from "./hyper_service";
import type { HyperAppendResult, HyperScope } from "./types";

const logger = log.scope("hyper_log_store");

export class HyperLogStore<T> {
  constructor(
    private readonly scope: HyperScope,
    private readonly subjectId: string,
  ) {}

  /** Append an event. Throws if the service can't satisfy the write. */
  async append(event: T): Promise<HyperAppendResult> {
    const svc = getHyperService();
    if (!svc.isReady()) {
      throw new Error(
        `HyperLogStore.append(${this.scope}/${this.subjectId}): service not started`,
      );
    }
    return svc.appendLog(this.scope, this.subjectId, event);
  }

  /**
   * Best-effort append. Returns `null` (and logs) if the service is offline
   * or the write fails. NEVER throws — safe to call from inside a critical
   * write path that has already committed to SQLite.
   */
  async tryAppend(event: T): Promise<HyperAppendResult | null> {
    const svc = getHyperService();
    if (!svc.isReady()) return null;
    try {
      return await svc.appendLog(this.scope, this.subjectId, event);
    } catch (err) {
      logger.warn(
        `tryAppend(${this.scope}/${this.subjectId}) failed`,
        err instanceof Error ? err.message : err,
      );
      return null;
    }
  }

  /** Read a slice of events. Throws if the service is not ready. */
  async read(opts: { start?: number; end?: number } = {}): Promise<T[]> {
    const svc = getHyperService();
    if (!svc.isReady()) {
      throw new Error(
        `HyperLogStore.read(${this.scope}/${this.subjectId}): service not started`,
      );
    }
    return (await svc.readLog(this.scope, this.subjectId, opts)) as T[];
  }
}
