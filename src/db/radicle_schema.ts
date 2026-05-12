import { sql } from "drizzle-orm";
import { integer, sqliteTable, text, index } from "drizzle-orm/sqlite-core";

// =============================================================================
// SOVEREIGN NETWORK — Radicle + Whitehat + Sovereign Models
// =============================================================================

/**
 * One row per Radicle repo seeded by this node. Tracks the link between a
 * JoyCreate `app` and the on-network RID, plus the latest signed whitehat
 * manifest hash so we can detect drift on subsequent pulls.
 */
export const radicleRepos = sqliteTable(
  "radicle_repos",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    rid: text("rid").notNull().unique(),
    appId: integer("app_id"),
    name: text("name").notNull(),
    defaultBranch: text("default_branch").notNull().default("main"),
    visibility: text("visibility", { enum: ["public", "private"] })
      .notNull()
      .default("public"),
    creatorDid: text("creator_did"),
    whitehatPolicyHash: text("whitehat_policy_hash"),
    whitehatAnchorHeight: integer("whitehat_anchor_height"),
    baseEditionTokenId: text("base_edition_token_id"),
    parentEditionTokenId: text("parent_edition_token_id"),
    parentRid: text("parent_rid"),
    lastSyncedAt: integer("last_synced_at", { mode: "timestamp" }),
    peerCount: integer("peer_count").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => ({
    appIdx: index("radicle_repos_app_id_idx").on(t.appId),
    parentIdx: index("radicle_repos_parent_rid_idx").on(t.parentRid),
  })
);

/**
 * DIDs the user has explicitly trusted to publish/sign code. Pulls from
 * unknown DIDs always trigger the LLM audit tier.
 */
export const radicleTrustedDids = sqliteTable(
  "radicle_trusted_dids",
  {
    did: text("did").primaryKey(),
    label: text("label"),
    trustLevel: text("trust_level", {
      enum: ["full", "manual-review", "blocked"],
    })
      .notNull()
      .default("manual-review"),
    addedAt: integer("added_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    notes: text("notes"),
  },
  (t) => ({
    levelIdx: index("radicle_trusted_dids_level_idx").on(t.trustLevel),
  })
);

/**
 * Audit log: one row per Whitehat manifest signature published or verified.
 * Mirrors `ssi_anchor_log` so the Celestia anchor lifecycle is consistent.
 */
export const whitehatAnchorLog = sqliteTable(
  "whitehat_anchor_log",
  {
    id: text("id").primaryKey(),
    rid: text("rid").notNull(),
    eventType: text("event_type", {
      enum: ["published", "verified", "rejected", "drifted"],
    }).notNull(),
    signerDid: text("signer_did").notNull(),
    manifestHash: text("manifest_hash").notNull(),
    signature: text("signature"),
    celestiaHeight: integer("celestia_height"),
    celestiaTxHash: text("celestia_tx_hash"),
    celestiaNamespace: text("celestia_namespace"),
    celestiaCommitment: text("celestia_commitment"),
    auditReportJson: text("audit_report_json", { mode: "json" }),
    anchoredAt: integer("anchored_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => ({
    ridIdx: index("whitehat_anchor_log_rid_idx").on(t.rid),
    signerIdx: index("whitehat_anchor_log_signer_idx").on(t.signerDid),
  })
);

/**
 * IPFS CIDs for AI model weights, plus their Celestia anchor (so the manifest
 * + content hash is immutable even if the original pinning host disappears).
 */
export const sovereignModelCids = sqliteTable(
  "sovereign_model_cids",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    cid: text("cid").notNull().unique(),
    modelName: text("model_name").notNull(),
    version: text("version").notNull(),
    sha256: text("sha256").notNull(),
    sizeBytes: integer("size_bytes").notNull().default(0),
    publisherDid: text("publisher_did"),
    celestiaHeight: integer("celestia_height"),
    celestiaCommitment: text("celestia_commitment"),
    celestiaNamespace: text("celestia_namespace"),
    pinnedLocally: integer("pinned_locally", { mode: "boolean" })
      .notNull()
      .default(false),
    metadataJson: text("metadata_json", { mode: "json" }),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => ({
    nameIdx: index("sovereign_model_cids_name_idx").on(t.modelName),
    publisherIdx: index("sovereign_model_cids_publisher_idx").on(t.publisherDid),
  })
);

export type RadicleRepoRow = typeof radicleRepos.$inferSelect;
export type RadicleRepoInsert = typeof radicleRepos.$inferInsert;
export type RadicleTrustedDidRow = typeof radicleTrustedDids.$inferSelect;
export type RadicleTrustedDidInsert = typeof radicleTrustedDids.$inferInsert;
export type WhitehatAnchorLogRow = typeof whitehatAnchorLog.$inferSelect;
export type WhitehatAnchorLogInsert = typeof whitehatAnchorLog.$inferInsert;
export type SovereignModelCidRow = typeof sovereignModelCids.$inferSelect;
export type SovereignModelCidInsert = typeof sovereignModelCids.$inferInsert;
