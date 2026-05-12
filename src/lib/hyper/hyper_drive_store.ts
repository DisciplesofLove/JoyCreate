/**
 * HyperDriveStore — typed file-blob adapter on top of HyperService's hyperdrive.
 *
 * Each instance is bound to ONE (scope, subjectId) topic. Use this to share
 * binary content (model weights, dataset shards, skill bundles) across
 * authenticated peers without going through Celestia / IPFS for every read.
 *
 * Like {@link HyperLogStore}, mutating ops have a `try*` variant that never
 * throws — safe to fire-and-forget after a local file has already been
 * persisted.
 */

import log from "electron-log";
import { getHyperService } from "./hyper_service";
import type { HyperScope } from "./types";

const logger = log.scope("hyper_drive_store");

export class HyperDriveStore {
  constructor(
    private readonly scope: HyperScope,
    private readonly subjectId: string,
  ) {}

  async put(filePath: string, data: Buffer | Uint8Array | string): Promise<void> {
    const svc = getHyperService();
    if (!svc.isReady()) {
      throw new Error(
        `HyperDriveStore.put(${this.scope}/${this.subjectId}): service not started`,
      );
    }
    await svc.drivePut(this.scope, this.subjectId, filePath, data);
  }

  async tryPut(
    filePath: string,
    data: Buffer | Uint8Array | string,
  ): Promise<boolean> {
    const svc = getHyperService();
    if (!svc.isReady()) return false;
    try {
      await svc.drivePut(this.scope, this.subjectId, filePath, data);
      return true;
    } catch (err) {
      logger.warn(
        `tryPut(${this.scope}/${this.subjectId} path=${filePath}) failed`,
        err instanceof Error ? err.message : err,
      );
      return false;
    }
  }

  async get(filePath: string): Promise<Buffer | null> {
    const svc = getHyperService();
    if (!svc.isReady()) {
      throw new Error(
        `HyperDriveStore.get(${this.scope}/${this.subjectId}): service not started`,
      );
    }
    return svc.driveGet(this.scope, this.subjectId, filePath);
  }

  async list(
    folder = "/",
  ): Promise<Array<{ key: string; size: number | null }>> {
    const svc = getHyperService();
    if (!svc.isReady()) {
      throw new Error(
        `HyperDriveStore.list(${this.scope}/${this.subjectId}): service not started`,
      );
    }
    return svc.driveList(this.scope, this.subjectId, folder);
  }
}
