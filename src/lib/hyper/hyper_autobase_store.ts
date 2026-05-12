/**
 * Multi-writer autobase wrapper (Phase 4).
 *
 * Same shape as {@link HyperLogStore} but every co-equal peer can write,
 * and the linearized view is computed deterministically by autobase. Use
 * this for collaborative resources where consensus matters: shared agent
 * memories, shared mission state, federated marketplace listings, etc.
 *
 * `tryAppend()` swallows errors so callers don't have to wrap each write.
 */

import log from "electron-log";
import { getHyperService } from "./hyper_service";
import type { HyperScope } from "./discovery";

const logger = log.scope("hyper_autobase_store");

export class HyperAutobaseStore<T = unknown> {
  constructor(
    private readonly scope: HyperScope,
    private readonly subjectId: string,
  ) {}

  async append(
    entry: T,
  ): Promise<{ localLength: number; viewLength: number }> {
    const svc = getHyperService();
    if (!svc.isReady()) await svc.start();
    return svc.autobaseAppend(this.scope, this.subjectId, entry);
  }

  async tryAppend(
    entry: T,
  ): Promise<{ localLength: number; viewLength: number } | null> {
    try {
      return await this.append(entry);
    } catch (err) {
      logger.warn(
        `tryAppend(${this.scope}/${this.subjectId}) failed`,
        err instanceof Error ? err.message : err,
      );
      return null;
    }
  }

  async read(opts: { start?: number; end?: number } = {}): Promise<T[]> {
    const svc = getHyperService();
    if (!svc.isReady()) await svc.start();
    return (await svc.autobaseRead(this.scope, this.subjectId, opts)) as T[];
  }

  /** Add a remote peer's writer key (hex). Caller must trust-verify first. */
  async addWriter(writerKeyHex: string): Promise<void> {
    const svc = getHyperService();
    if (!svc.isReady()) await svc.start();
    await svc.addAutobaseWriter(this.scope, this.subjectId, writerKeyHex);
  }

  /** Hex of this device's local writer key — share with peers to be invited. */
  async getLocalWriterKey(): Promise<string> {
    const svc = getHyperService();
    if (!svc.isReady()) await svc.start();
    return svc.getAutobaseLocalKey(this.scope, this.subjectId);
  }
}
