import { ipcMain } from "electron";
import path from "node:path";
import fs from "fs-extra";
import { eq, sql } from "drizzle-orm";

import * as radicle from "@/lib/radicle/radicle_client";
import { db } from "@/db";
import { apps } from "@/db/schema";
import {
  radicleRepos,
  radicleTrustedDids,
  whitehatAnchorLog,
  type RadicleRepoRow,
  type RadicleTrustedDidRow,
} from "@/db/radicle_schema";
import { randomUUID } from "node:crypto";
import { getJoyAppPath } from "@/paths/paths";
import {
  generateManifest,
  signManifest,
  writeManifest,
  readManifest,
  type WhitehatPolicy,
} from "@/lib/radicle/whitehat_manifest";
import { auditPull, type AuditResult } from "@/lib/radicle/whitehat_audit";

// =============================================================================
// PARAM TYPES
// =============================================================================

export interface CreateIdentityParams {
  alias: string;
  passphrase: string;
}

export interface PublishRepoParams {
  appId: number;
  name: string;
  description?: string;
  defaultBranch?: string;
  visibility?: "public" | "private";
  passphrase: string;
  /** Optional whitehat manifest signing — when provided, generates + signs whitehat.json */
  whitehat?: {
    creatorDid: string;
    privateKeyHex: string;
    policy?: Partial<WhitehatPolicy>;
  };
}

export interface CloneRepoParams {
  rid: string;
  /** Where to put the clone. If omitted, derives from getJoyAppPath. */
  targetDir?: string;
  /** App name to register the clone under in `apps` table. */
  registerAsAppName?: string;
  passphrase?: string;
}

export interface SyncRepoParams {
  appId?: number;
  cwd?: string;
  passphrase?: string;
}

export interface AddTrustedDidParams {
  did: string;
  label?: string;
  trustLevel: "full" | "manual-review" | "blocked";
  notes?: string;
}

export interface AuditRepoParams {
  appId: number;
}

// =============================================================================
// HELPERS
// =============================================================================

async function loadAppOrThrow(appId: number) {
  const [app] = await db.select().from(apps).where(eq(apps.id, appId)).limit(1);
  if (!app) throw new Error(`App not found: ${appId}`);
  return app;
}

async function loadRepoOrThrow(appId: number): Promise<RadicleRepoRow> {
  const [repo] = await db
    .select()
    .from(radicleRepos)
    .where(eq(radicleRepos.appId, appId))
    .limit(1);
  if (!repo) throw new Error(`No Radicle repo registered for app ${appId}`);
  return repo;
}

async function getTrustLevelForDid(
  did: string,
): Promise<"full" | "manual-review" | "blocked" | "unknown"> {
  const [row] = await db
    .select()
    .from(radicleTrustedDids)
    .where(eq(radicleTrustedDids.did, did))
    .limit(1);
  return (row?.trustLevel as RadicleTrustedDidRow["trustLevel"] | undefined) ?? "unknown";
}

// =============================================================================
// HANDLER REGISTRATION
// =============================================================================

export function registerRadicleHandlers(): void {
  // ── Node ───────────────────────────────────────────────────────────────────
  ipcMain.handle("radicle:node:status", async () => radicle.nodeStatus());

  // ── Identity ───────────────────────────────────────────────────────────────
  ipcMain.handle(
    "radicle:identity:create",
    async (_, params: CreateIdentityParams) => {
      if (!params?.alias?.trim()) throw new Error("alias is required");
      if (!params?.passphrase) throw new Error("passphrase is required");
      return radicle.createIdentity(params);
    },
  );

  ipcMain.handle("radicle:identity:get", async () => radicle.getSelf());

  ipcMain.handle("radicle:identity:has", async () => radicle.hasIdentity());

  // ── Repos ──────────────────────────────────────────────────────────────────
  ipcMain.handle(
    "radicle:repo:publish",
    async (_, params: PublishRepoParams) => {
      if (!params?.appId) throw new Error("appId is required");
      if (!params?.name?.trim()) throw new Error("name is required");
      if (!params?.passphrase) throw new Error("passphrase is required");

      const app = await loadAppOrThrow(params.appId);
      const repoRoot = getJoyAppPath(app.path);
      if (!(await fs.pathExists(repoRoot))) {
        throw new Error(`App working dir does not exist: ${repoRoot}`);
      }

      // 1. rad init
      const init = await radicle.initRepo({
        cwd: repoRoot,
        name: params.name,
        description: params.description ?? "",
        defaultBranch: params.defaultBranch,
        visibility: params.visibility,
        passphrase: params.passphrase,
      });

      // 2. Optional whitehat manifest
      let whitehatHash: string | undefined;
      if (params.whitehat) {
        const manifest = await generateManifest({
          repoRoot,
          rid: init.rid,
          name: params.name,
          description: params.description,
          creatorDid: params.whitehat.creatorDid,
          policy: params.whitehat.policy,
        });
        const envelope = signManifest({
          manifest,
          privateKeyHex: params.whitehat.privateKeyHex,
          signerDid: params.whitehat.creatorDid,
        });
        await writeManifest(repoRoot, manifest, envelope);
        whitehatHash = manifest.contentHash;
      }

      // 3. rad push
      await radicle.pushRepo({ cwd: repoRoot, passphrase: params.passphrase });

      // 4. Persist row
      const self = await radicle.getSelf().catch(() => null);
      const now = new Date();
      await db
        .insert(radicleRepos)
        .values({
          rid: init.rid,
          appId: params.appId,
          name: params.name,
          defaultBranch: params.defaultBranch ?? "main",
          visibility: params.visibility ?? "public",
          creatorDid: self?.did ?? null,
          whitehatPolicyHash: whitehatHash ?? null,
          whitehatAnchorHeight: null,
          baseEditionTokenId: null,
          parentEditionTokenId: null,
          parentRid: null,
          lastSyncedAt: now,
          peerCount: 0,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: radicleRepos.rid,
          set: {
            appId: params.appId,
            name: params.name,
            whitehatPolicyHash: whitehatHash ?? null,
            updatedAt: now,
          },
        });

      return {
        rid: init.rid,
        whitehatContentHash: whitehatHash ?? null,
      };
    },
  );

  ipcMain.handle("radicle:repo:clone", async (_, params: CloneRepoParams) => {
    if (!params?.rid?.trim()) throw new Error("rid is required");

    const targetDir =
      params.targetDir ??
      getJoyAppPath(`radicle-clones/${params.rid.replace(/[^a-z0-9]/gi, "_")}`);
    await fs.ensureDir(path.dirname(targetDir));

    await radicle.cloneRepo({
      rid: params.rid,
      targetDir,
      passphrase: params.passphrase,
    });

    // Optional: register as a JoyCreate app
    let appId: number | null = null;
    if (params.registerAsAppName?.trim()) {
      const now = new Date();
      const inserted = await db
        .insert(apps)
        .values({
          name: params.registerAsAppName.trim(),
          path: path
            .relative(getJoyAppPath("."), targetDir)
            .split(path.sep)
            .join("/"),
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: apps.id });
      appId = inserted[0]?.id ?? null;
    }

    const now = new Date();
    await db
      .insert(radicleRepos)
      .values({
        rid: params.rid,
        appId,
        name: params.registerAsAppName ?? params.rid,
        defaultBranch: "main",
        visibility: "public",
        creatorDid: null,
        whitehatPolicyHash: null,
        whitehatAnchorHeight: null,
        baseEditionTokenId: null,
        parentEditionTokenId: null,
        parentRid: null,
        lastSyncedAt: now,
        peerCount: 0,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: radicleRepos.rid,
        set: { appId, lastSyncedAt: now, updatedAt: now },
      });

    return { rid: params.rid, targetDir, appId };
  });

  ipcMain.handle("radicle:repo:list", async () => {
    const rows = await db.select().from(radicleRepos);
    let nodeRepos: Awaited<ReturnType<typeof radicle.listRepos>> = [];
    try {
      nodeRepos = await radicle.listRepos();
    } catch {
      // Node may be offline — fall back to DB-only.
    }
    return {
      registered: rows,
      node: nodeRepos,
    };
  });

  ipcMain.handle("radicle:repo:sync", async (_, params: SyncRepoParams) => {
    let cwd = params?.cwd;
    if (!cwd && params?.appId) {
      const app = await loadAppOrThrow(params.appId);
      cwd = getJoyAppPath(app.path);
    }
    if (!cwd) throw new Error("Either appId or cwd is required");
    await radicle.syncRepo({ cwd, passphrase: params.passphrase });
    if (params?.appId) {
      await db
        .update(radicleRepos)
        .set({ lastSyncedAt: new Date(), updatedAt: new Date() })
        .where(eq(radicleRepos.appId, params.appId));
    }
    return { ok: true };
  });

  ipcMain.handle("radicle:repo:peers", async (_, rid: string) => {
    if (!rid?.trim()) throw new Error("rid is required");
    const peers = await radicle.repoPeers(rid);
    await db
      .update(radicleRepos)
      .set({ peerCount: peers.length, updatedAt: new Date() })
      .where(eq(radicleRepos.rid, rid));
    return peers;
  });

  // ── Trust list ─────────────────────────────────────────────────────────────
  ipcMain.handle("radicle:trust:list", async () => {
    return db.select().from(radicleTrustedDids);
  });

  ipcMain.handle(
    "radicle:trust:add",
    async (_, params: AddTrustedDidParams) => {
      if (!params?.did?.trim()) throw new Error("did is required");
      if (!params?.trustLevel) throw new Error("trustLevel is required");
      const now = new Date();
      await db
        .insert(radicleTrustedDids)
        .values({
          did: params.did,
          label: params.label ?? null,
          trustLevel: params.trustLevel,
          notes: params.notes ?? null,
          addedAt: now,
        })
        .onConflictDoUpdate({
          target: radicleTrustedDids.did,
          set: {
            label: params.label ?? null,
            trustLevel: params.trustLevel,
            notes: params.notes ?? null,
          },
        });
      return { ok: true };
    },
  );

  ipcMain.handle("radicle:trust:remove", async (_, did: string) => {
    if (!did?.trim()) throw new Error("did is required");
    await db.delete(radicleTrustedDids).where(eq(radicleTrustedDids.did, did));
    return { ok: true };
  });

  // ── Whitehat audit ─────────────────────────────────────────────────────────
  ipcMain.handle(
    "radicle:audit:run",
    async (_, params: AuditRepoParams): Promise<AuditResult> => {
      if (!params?.appId) throw new Error("appId is required");
      const app = await loadAppOrThrow(params.appId);
      const repoRoot = getJoyAppPath(app.path);
      const loaded = await readManifest(repoRoot);
      if (!loaded) {
        throw new Error(
          `No whitehat manifest in ${repoRoot} — publish with whitehat enabled first`,
        );
      }
      const trustLevel = await getTrustLevelForDid(loaded.envelope.signerDid);

      // signerPublicKeyHex is normally resolved from the DID document. For now
      // we require trust-list entries to carry the key in `notes` as a hex
      // string; otherwise the static signature check will fail and the audit
      // will block. A future iteration will plug into ssi_identities lookup.
      const [trustRow] = await db
        .select()
        .from(radicleTrustedDids)
        .where(eq(radicleTrustedDids.did, loaded.envelope.signerDid))
        .limit(1);
      const signerPublicKeyHex = trustRow?.notes?.trim() ?? "";

      const result = await auditPull({
        repoRoot,
        manifest: loaded.manifest,
        envelope: loaded.envelope,
        signerPublicKeyHex,
        trustLevel,
      });

      // Log the verification attempt
      await db.insert(whitehatAnchorLog).values({
        id: randomUUID(),
        rid: loaded.manifest.rid,
        eventType: result.blocked
          ? "rejected"
          : result.staticReport.fileHashesMatch
            ? "verified"
            : "drifted",
        signerDid: loaded.envelope.signerDid,
        manifestHash: loaded.manifest.contentHash,
        signature: loaded.envelope.signature,
        celestiaHeight: null,
        celestiaCommitment: null,
        celestiaNamespace: null,
        celestiaTxHash: null,
        auditReportJson: result as unknown as Record<string, unknown>,
        anchoredAt: new Date(),
      });

      return result;
    },
  );

  // ── Anchor log read ────────────────────────────────────────────────────────
  ipcMain.handle("radicle:audit:history", async (_, rid: string) => {
    if (!rid?.trim()) throw new Error("rid is required");
    return db
      .select()
      .from(whitehatAnchorLog)
      .where(eq(whitehatAnchorLog.rid, rid))
      .orderBy(sql`${whitehatAnchorLog.anchoredAt} DESC`)
      .limit(100);
  });

  // ── Seed nodes (peer connect / repo seed) ────────────────────────────────
  ipcMain.handle("radicle:seeds:presets", async () => {
    return radicle.RADICLE_SEED_PRESETS;
  });

  ipcMain.handle("radicle:seeds:list-sessions", async () => {
    return radicle.listSeedSessions();
  });

  ipcMain.handle(
    "radicle:seeds:connect",
    async (_, params: { address: string }) => {
      if (!params?.address?.trim()) throw new Error("address is required");
      await radicle.connectSeed(params.address.trim());
      return { ok: true };
    },
  );

  ipcMain.handle(
    "radicle:seeds:disconnect",
    async (_, params: { nid: string }) => {
      if (!params?.nid?.trim()) throw new Error("nid is required");
      await radicle.disconnectSeed(params.nid.trim());
      return { ok: true };
    },
  );

  ipcMain.handle(
    "radicle:seeds:seed-repo",
    async (_, params: { rid: string; scope?: "all" | "trusted" }) => {
      if (!params?.rid?.trim()) throw new Error("rid is required");
      await radicle.seedRepo({ rid: params.rid.trim(), scope: params.scope });
      return { ok: true };
    },
  );

  ipcMain.handle(
    "radicle:seeds:unseed-repo",
    async (_, params: { rid: string }) => {
      if (!params?.rid?.trim()) throw new Error("rid is required");
      await radicle.unseedRepo(params.rid.trim());
      return { ok: true };
    },
  );
}
