/**
 * HyperKvStore<V> — typed key/value adapter on top of HyperService's hyperbee.
 *
 * Each instance is bound to ONE (scope, subjectId) topic. Use this for
 * registries, channel/subscription state, or any cross-device materialized
 * view that doesn't need an append-only audit trail.
 *
 * Like {@link HyperLogStore}, mutating ops have a `try*` variant that never
 * throws — safe to fire-and-forget from the critical write path.
 */

import log from "electron-log";
import { getHyperService } from "./hyper_service";
import type { HyperScope } from "./types";

const logger = log.scope("hyper_kv_store");

export class HyperKvStore<V = unknown> {
  constructor(
    private readonly scope: HyperScope,
    private readonly subjectId: string,
  ) {}

  async put(key: string, value: V): Promise<void> {
    const svc = getHyperService();
    if (!svc.isReady()) {
      throw new Error(
        `HyperKvStore.put(${this.scope}/${this.subjectId}): service not started`,
      );
    }
    await svc.beePut(this.scope, this.subjectId, key, value);
  }

  async tryPut(key: string, value: V): Promise<boolean> {
    const svc = getHyperService();
    if (!svc.isReady()) return false;
    try {
      await svc.beePut(this.scope, this.subjectId, key, value);
      return true;
    } catch (err) {
      logger.warn(
        `tryPut(${this.scope}/${this.subjectId} key=${key}) failed`,
        err instanceof Error ? err.message : err,
      );
      return false;
    }
  }

  async get(key: string): Promise<V | null> {
    const svc = getHyperService();
    if (!svc.isReady()) {
      throw new Error(
        `HyperKvStore.get(${this.scope}/${this.subjectId}): service not started`,
      );
    }
    return (await svc.beeGet(this.scope, this.subjectId, key)) as V | null;
  }

  async list(
    opts: { gte?: string; lt?: string; limit?: number } = {},
  ): Promise<Array<{ key: string; value: V }>> {
    const svc = getHyperService();
    if (!svc.isReady()) {
      throw new Error(
        `HyperKvStore.list(${this.scope}/${this.subjectId}): service not started`,
      );
    }
    return (await svc.beeList(this.scope, this.subjectId, opts)) as Array<{
      key: string;
      value: V;
    }>;
  }
}
