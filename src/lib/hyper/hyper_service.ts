/**
 * HyperService — singleton owner of the Hypercore peer layer.
 *
 * Lifecycle
 * ---------
 *  • Lazy singleton — `getHyperService()` returns the instance but does NOT
 *    auto-start replication. Callers must invoke `start()` explicitly (the
 *    main bootstrap does this when the user has the feature flag enabled).
 *  • Owns ONE `Corestore` rooted at `<userData>/corestore` and ONE
 *    `Hyperswarm` instance. All cores, hyperbees and hyperdrives are derived
 *    from this corestore.
 *
 * Identity
 * --------
 *  • Phase 0 binds the swarm key-pair to a per-device random seed persisted
 *    at `<userData>/corestore/keypair.json`. Phase 5 replaces this with an
 *    HKDF-derived sub-key from the SSI seed (info string
 *    `"joycreate/hyper/v1"`).
 *
 * Topic registry
 * --------------
 *  • A "topic" is a (scope, subjectId) pair. Each topic owns exactly one
 *    underlying object (hypercore | hyperbee | hyperdrive) and is auto-joined
 *    on the swarm when opened. The discovery key is the blake2b-256 hash of
 *    `joycreate:<scope>:<subjectId>` (see {@link ./discovery.ts}).
 *
 * Holepunch packages are loaded via dynamic `import()` so the renderer build
 * never sees them and so vite's main bundle stays externalized.
 */

import path from "node:path";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import log from "electron-log";
import { getUserDataPath } from "@/paths/paths";
import {
  type HyperAppendResult,
  type HyperPeerInfo,
  type HyperServiceStatus,
  type HyperTopicInfo,
} from "./types";
import { corestoreName, makeTopicId, type TopicId } from "./discovery";

const logger = log.scope("hyper_service");

// ---------------------------------------------------------------------------
// Dynamic-import shims — the Holepunch packages are CJS/ESM hybrids that
// vite externalizes; we resolve them at runtime in the main process only.
// ---------------------------------------------------------------------------

interface HolepunchModules {
  Corestore: any;
  Hyperswarm: any;
  Hyperbee: any;
  Hyperdrive: any;
  Autobase: any;
  b4a: any;
}

let holepunchPromise: Promise<HolepunchModules> | null = null;

async function loadHolepunch(): Promise<HolepunchModules> {
  if (holepunchPromise) return holepunchPromise;
  holepunchPromise = (async () => {
    const [Corestore, Hyperswarm, Hyperbee, Hyperdrive, Autobase, b4a] = await Promise.all([
      import("corestore").then((m) => m.default ?? m),
      import("hyperswarm").then((m) => m.default ?? m),
      import("hyperbee").then((m) => m.default ?? m),
      import("hyperdrive").then((m) => m.default ?? m),
      import("autobase").then((m) => m.default ?? m),
      import("b4a").then((m) => m.default ?? m),
    ]);
    return { Corestore, Hyperswarm, Hyperbee, Hyperdrive, Autobase, b4a };
  })();
  return holepunchPromise;
}

// ---------------------------------------------------------------------------
// Internal topic record — one per (scope, subjectId) currently open.
// ---------------------------------------------------------------------------

interface OpenTopic {
  id: TopicId;
  type: "log" | "bee" | "drive" | "autobase";
  /** Underlying primitive: hypercore | hyperbee | hyperdrive | autobase. */
  obj: any;
  /** The hyperswarm discovery handle returned by swarm.join(...). */
  discovery: any | null;
  joinedAt: number;
}

// ---------------------------------------------------------------------------
// HyperService
// ---------------------------------------------------------------------------

export class HyperService extends EventEmitter {
  private store: any | null = null;
  private swarm: any | null = null;
  private rootDir: string;
  private startedAt: number | null = null;
  private startPromise: Promise<void> | null = null;
  private topics = new Map<string, OpenTopic>();
  private peers = new Map<string, HyperPeerInfo>();
  private deviceKeyHex: string | null = null;
  private ssiDid: string | null = null;

  constructor() {
    super();
    this.rootDir = path.join(getUserDataPath(), "corestore");
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  isReady(): boolean {
    return this.store != null && this.swarm != null;
  }

  /**
   * Start the corestore + swarm. Idempotent and concurrency-safe.
   */
  async start(): Promise<void> {
    if (this.isReady()) return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.doStart().catch((err) => {
      this.startPromise = null;
      throw err;
    });
    return this.startPromise;
  }

  private async doStart(): Promise<void> {
    fs.mkdirSync(this.rootDir, { recursive: true });
    const { Corestore, Hyperswarm, b4a } = await loadHolepunch();

    this.store = new Corestore(this.rootDir);
    await this.store.ready();

    // Use the corestore's primary key as a stable device identity; hyperswarm
    // takes the keyPair so peers can authenticate us across reconnects.
    // corestore@7.9+ made createKeyPair async — must await or publicKey is undefined.
    const keyPair = await this.store.createKeyPair("joycreate-swarm-identity");
    this.deviceKeyHex = b4a.toString(keyPair.publicKey, "hex");

    // Bind to SSI identity (Phase 5). Best-effort — pre-onboarding launches
    // are allowed to run unbound. Lazy import keeps DB loaded out of the
    // hot path during cold start.
    try {
      const { resolveHyperIdentity } = await import("./ssi_binding");
      const binding = await resolveHyperIdentity();
      this.ssiDid = binding.did;
    } catch (err) {
      logger.warn("SSI binding failed (continuing unbound)", err);
    }

    this.swarm = new Hyperswarm({ keyPair });

    // Replicate every accepted connection through the corestore — corestore
    // multiplexes all cores it owns onto a single noise stream.
    this.swarm.on("connection", (conn: any, info: any) => {
      const remoteKeyHex = b4a.toString(info.publicKey, "hex");
      const now = Date.now();
      const existing = this.peers.get(remoteKeyHex);
      this.peers.set(remoteKeyHex, {
        publicKeyHex: remoteKeyHex,
        remoteHostHex: info.remotePublicKey
          ? b4a.toString(info.remotePublicKey, "hex")
          : null,
        topicsHex: existing?.topicsHex ?? [],
        firstSeenAt: existing?.firstSeenAt ?? now,
        lastSeenAt: now,
      });
      conn.on("close", () => {
        this.peers.delete(remoteKeyHex);
      });
      try {
        this.store.replicate(conn);
      } catch (err) {
        logger.warn("replicate(conn) failed", err);
      }
      this.emit("peer:connect", remoteKeyHex);
    });

    this.startedAt = Date.now();
    logger.info(
      `HyperService started — root=${this.rootDir} device=${this.deviceKeyHex?.slice(0, 12)}…`,
    );
    this.emit("ready");
  }

  async stop(): Promise<void> {
    try {
      // Leave all topics first so swarm.destroy() doesn't race.
      const ids = [...this.topics.keys()];
      for (const id of ids) {
        try {
          await this.leaveTopicByKey(id);
        } catch (err) {
          logger.warn(`leave topic ${id} failed`, err);
        }
      }
      if (this.swarm) {
        await this.swarm.destroy();
        this.swarm = null;
      }
      if (this.store) {
        await this.store.close();
        this.store = null;
      }
      this.startedAt = null;
      this.startPromise = null;
      this.peers.clear();
      this.topics.clear();
      logger.info("HyperService stopped");
    } catch (err) {
      logger.error("stop failed", err);
      throw err;
    }
  }

  status(): HyperServiceStatus {
    return {
      enabled: true,
      ready: this.isReady(),
      deviceKeyHex: this.deviceKeyHex,
      swarmConnections: this.peers.size,
      topicsCount: this.topics.size,
      rootDir: this.rootDir,
      startedAt: this.startedAt,
      ssiDid: this.ssiDid,
    };
  }

  // -------------------------------------------------------------------------
  // Topic / core management
  // -------------------------------------------------------------------------

  private requireReady(): void {
    if (!this.isReady()) {
      throw new Error("HyperService not started — call start() first");
    }
  }

  private async joinSwarm(topicId: TopicId): Promise<any> {
    const { b4a } = await loadHolepunch();
    const topic = b4a.from(topicId.discoveryKeyHex, "hex");
    const discovery = this.swarm.join(topic, { client: true, server: true });
    // We do NOT block on discovery.flushed() here — Phase 0 wants topic
    // open to return fast; replication can warm up in the background.
    discovery.flushed().catch((err: unknown) => {
      logger.warn(`flush ${topicId.key} failed`, err);
    });
    return discovery;
  }

  /**
   * Open (or create) a hypercore log under the given topic.
   * Idempotent — repeated calls return the same instance.
   */
  async openLog(scope: string, subjectId: string): Promise<any> {
    this.requireReady();
    const id = makeTopicId(scope, subjectId);
    const existing = this.topics.get(id.key);
    if (existing && existing.type === "log") return existing.obj;
    if (existing) {
      throw new Error(
        `Topic ${id.key} already opened as ${existing.type}, cannot reopen as log`,
      );
    }
    const core = this.store.get({ name: corestoreName(scope, subjectId) });
    await core.ready();
    const discovery = await this.joinSwarm(id);
    this.topics.set(id.key, {
      id,
      type: "log",
      obj: core,
      discovery,
      joinedAt: Date.now(),
    });
    return core;
  }

  async openBee(scope: string, subjectId: string): Promise<any> {
    this.requireReady();
    const id = makeTopicId(scope, subjectId);
    const existing = this.topics.get(id.key);
    if (existing && existing.type === "bee") return existing.obj;
    if (existing) {
      throw new Error(
        `Topic ${id.key} already opened as ${existing.type}, cannot reopen as bee`,
      );
    }
    const { Hyperbee } = await loadHolepunch();
    const core = this.store.get({ name: corestoreName(scope, subjectId) });
    await core.ready();
    const bee = new Hyperbee(core, {
      keyEncoding: "utf-8",
      valueEncoding: "json",
    });
    await bee.ready();
    const discovery = await this.joinSwarm(id);
    this.topics.set(id.key, {
      id,
      type: "bee",
      obj: bee,
      discovery,
      joinedAt: Date.now(),
    });
    return bee;
  }

  async openDrive(scope: string, subjectId: string): Promise<any> {
    this.requireReady();
    const id = makeTopicId(scope, subjectId);
    const existing = this.topics.get(id.key);
    if (existing && existing.type === "drive") return existing.obj;
    if (existing) {
      throw new Error(
        `Topic ${id.key} already opened as ${existing.type}, cannot reopen as drive`,
      );
    }
    const { Hyperdrive } = await loadHolepunch();
    // Hyperdrive uses a nested namespace inside the corestore so its metadata
    // and blob cores both rendezvous under the same discovery key.
    const ns = this.store.namespace(corestoreName(scope, subjectId));
    const drive = new Hyperdrive(ns);
    await drive.ready();
    const discovery = await this.joinSwarm(id);
    this.topics.set(id.key, {
      id,
      type: "drive",
      obj: drive,
      discovery,
      joinedAt: Date.now(),
    });
    return drive;
  }

  /**
   * Phase 4 — Autobase multi-writer.
   *
   * Opens (or joins) a multi-writer log for `(scope, subjectId)`. Each peer
   * gets a local writer hypercore; an autobase view linearizes everyone's
   * writes into a single causal order. The topic's discovery key derives
   * from `(scope, subjectId)` so all writers rendezvous on the same swarm
   * topic regardless of which device bootstraps the room first.
   *
   * Initial writer set is `[localWriterCore]`; remote writers must be
   * added explicitly via {@link addAutobaseWriter} once you've trust-vetted
   * their key (typically through SSI / collab handshake).
   */
  async openAutobase(scope: string, subjectId: string): Promise<any> {
    this.requireReady();
    const id = makeTopicId(scope, subjectId);
    const existing = this.topics.get(id.key);
    if (existing && existing.type === "autobase") return existing.obj;
    if (existing) {
      throw new Error(
        `Topic ${id.key} already opened as ${existing.type}, cannot reopen as autobase`,
      );
    }
    const { Autobase } = await loadHolepunch();
    const { b4a } = await loadHolepunch();
    // The "local" writer core is per-device + per-room; the "view" core is
    // shared (deterministic from the topic) so all peers compute the same
    // linearized output. We use the corestore namespace to scope both.
    const ns = this.store.namespace(corestoreName(scope, subjectId));
    const localWriter = ns.get({ name: "writer" });
    await localWriter.ready();
    const base = new Autobase(this.store, null, {
      open: (viewStore: any) => {
        const view = viewStore.get("view", { valueEncoding: "json" });
        return view;
      },
      apply: async (nodes: any[], view: any, host: any) => {
        for (const node of nodes) {
          if (node.value?.type === "addWriter" && node.value.key) {
            try {
              await host.addWriter(b4a.from(node.value.key, "hex"), {
                indexer: true,
              });
            } catch {
              /* ignore */
            }
            continue;
          }
          await view.append(node.value);
        }
      },
      valueEncoding: "json",
    });
    await base.ready();
    const discovery = await this.joinSwarm(id);
    this.topics.set(id.key, {
      id,
      type: "autobase",
      obj: base,
      discovery,
      joinedAt: Date.now(),
    });
    return base;
  }

  /**
   * Append an entry as the local writer. Returns the local seq.
   * Multi-writer ordering is determined by the autobase apply() pass.
   */
  async autobaseAppend(
    scope: string,
    subjectId: string,
    entry: unknown,
  ): Promise<{ localLength: number; viewLength: number }> {
    const base = await this.openAutobase(scope, subjectId);
    await base.append(entry);
    return {
      localLength: base.local?.length ?? 0,
      viewLength: base.view?.length ?? 0,
    };
  }

  /** Read linearized view entries `[start, end)`. */
  async autobaseRead(
    scope: string,
    subjectId: string,
    opts: { start?: number; end?: number } = {},
  ): Promise<unknown[]> {
    const base = await this.openAutobase(scope, subjectId);
    const view = base.view;
    if (!view) return [];
    const start = opts.start ?? 0;
    const end = Math.min(opts.end ?? view.length, view.length);
    const out: unknown[] = [];
    for (let i = start; i < end; i++) out.push(await view.get(i));
    return out;
  }

  /**
   * Add a remote writer (hex public key) to the autobase. Encoded as a
   * special control entry that the apply() handler intercepts. The writer
   * is added on the next apply pass.
   */
  async addAutobaseWriter(
    scope: string,
    subjectId: string,
    writerKeyHex: string,
  ): Promise<void> {
    if (!/^[0-9a-f]{64}$/i.test(writerKeyHex)) {
      throw new Error("addAutobaseWriter: writerKeyHex must be 32-byte hex");
    }
    const base = await this.openAutobase(scope, subjectId);
    await base.append({ type: "addWriter", key: writerKeyHex });
  }

  /** Hex of this device's local writer key for the given topic. */
  async getAutobaseLocalKey(
    scope: string,
    subjectId: string,
  ): Promise<string> {
    const base = await this.openAutobase(scope, subjectId);
    const { b4a } = await loadHolepunch();
    return b4a.toString(base.local.key, "hex");
  }

  async leaveTopic(scope: string, subjectId: string): Promise<void> {
    const id = makeTopicId(scope, subjectId);
    return this.leaveTopicByKey(id.key);
  }

  private async leaveTopicByKey(key: string): Promise<void> {
    const t = this.topics.get(key);
    if (!t) return;
    try {
      if (t.discovery) await t.discovery.destroy();
    } catch (err) {
      logger.warn(`discovery destroy ${key} failed`, err);
    }
    try {
      if (t.type === "drive") {
        await t.obj.close();
      } else if (t.type === "bee") {
        await t.obj.close();
      } else {
        await t.obj.close();
      }
    } catch (err) {
      logger.warn(`close ${key} failed`, err);
    }
    this.topics.delete(key);
  }

  // -------------------------------------------------------------------------
  // High-level operations exposed via IPC
  // -------------------------------------------------------------------------

  async appendLog(
    scope: string,
    subjectId: string,
    entry: unknown,
  ): Promise<HyperAppendResult> {
    const { b4a } = await loadHolepunch();
    const core = await this.openLog(scope, subjectId);
    const buf = b4a.from(JSON.stringify(entry));
    const seq = (await core.append(buf)) as number;
    // hypercore returns the *new* length; the appended block is at length-1.
    const blockSeq = typeof seq === "number" ? seq : core.length;
    const block = await core.get(blockSeq - 1);
    const { createHash } = await import("node:crypto");
    const hashHex = createHash("sha256").update(block).digest("hex");
    return {
      seq: blockSeq,
      hashHex,
      discoveryKeyHex: makeTopicId(scope, subjectId).discoveryKeyHex,
    };
  }

  async readLog(
    scope: string,
    subjectId: string,
    opts: { start?: number; end?: number } = {},
  ): Promise<unknown[]> {
    const core = await this.openLog(scope, subjectId);
    const start = Math.max(0, opts.start ?? 0);
    const end = Math.min(core.length, opts.end ?? core.length);
    const out: unknown[] = [];
    for (let i = start; i < end; i++) {
      const buf = await core.get(i);
      try {
        out.push(JSON.parse(buf.toString()));
      } catch {
        out.push(buf.toString());
      }
    }
    return out;
  }

  async beePut(
    scope: string,
    subjectId: string,
    key: string,
    value: unknown,
  ): Promise<void> {
    const bee = await this.openBee(scope, subjectId);
    await bee.put(key, value);
  }

  async beeGet(
    scope: string,
    subjectId: string,
    key: string,
  ): Promise<unknown | null> {
    const bee = await this.openBee(scope, subjectId);
    const node = await bee.get(key);
    return node?.value ?? null;
  }

  async beeList(
    scope: string,
    subjectId: string,
    opts: { gte?: string; lt?: string; limit?: number } = {},
  ): Promise<Array<{ key: string; value: unknown }>> {
    const bee = await this.openBee(scope, subjectId);
    const out: Array<{ key: string; value: unknown }> = [];
    const stream = bee.createReadStream({
      gte: opts.gte,
      lt: opts.lt,
      limit: opts.limit ?? 1000,
    });
    for await (const node of stream) {
      out.push({ key: String(node.key), value: node.value });
    }
    return out;
  }

  async drivePut(
    scope: string,
    subjectId: string,
    filePath: string,
    data: Buffer | Uint8Array | string,
  ): Promise<void> {
    const { b4a } = await loadHolepunch();
    const drive = await this.openDrive(scope, subjectId);
    const buf =
      typeof data === "string"
        ? b4a.from(data)
        : data instanceof Uint8Array
          ? b4a.from(data)
          : b4a.from(data);
    await drive.put(filePath, buf);
  }

  async driveGet(
    scope: string,
    subjectId: string,
    filePath: string,
  ): Promise<Buffer | null> {
    const drive = await this.openDrive(scope, subjectId);
    const buf = await drive.get(filePath);
    if (!buf) return null;
    return Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  }

  async driveList(
    scope: string,
    subjectId: string,
    folder = "/",
  ): Promise<Array<{ key: string; size: number | null }>> {
    const drive = await this.openDrive(scope, subjectId);
    const out: Array<{ key: string; size: number | null }> = [];
    for await (const entry of drive.list(folder, { recursive: true })) {
      out.push({
        key: entry.key,
        size: entry.value?.blob?.byteLength ?? null,
      });
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Introspection
  // -------------------------------------------------------------------------

  async listTopics(): Promise<HyperTopicInfo[]> {
    const { b4a } = await loadHolepunch();
    const out: HyperTopicInfo[] = [];
    for (const t of this.topics.values()) {
      // For bees / drives, `core` lives on .core (Hyperbee.core, Hyperdrive.core).
      // Autobase exposes its linearized output via `.view` (a hypercore).
      const core =
        t.type === "log"
          ? t.obj
          : t.type === "autobase"
            ? (t.obj.view ?? t.obj.local ?? null)
            : (t.obj.core ?? t.obj.feed ?? null);
      const length = core?.length ?? 0;
      const writerKeyHex = core?.key ? b4a.toString(core.key, "hex") : "";
      const treeHashHex =
        core?.treeHash && length > 0
          ? b4a.toString(core.treeHash(), "hex")
          : null;
      out.push({
        scope: t.id.scope,
        subjectId: t.id.subjectId,
        discoveryKeyHex: t.id.discoveryKeyHex,
        type: t.type,
        length,
        writerKeyHex,
        treeHashHex,
        joinedAt: t.joinedAt,
      });
    }
    return out;
  }

  listPeers(): HyperPeerInfo[] {
    return [...this.peers.values()];
  }
}

// ---------------------------------------------------------------------------
// Singleton accessor
// ---------------------------------------------------------------------------

let instance: HyperService | null = null;

export function getHyperService(): HyperService {
  if (!instance) instance = new HyperService();
  return instance;
}
