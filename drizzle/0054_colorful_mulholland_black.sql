CREATE TABLE `radicle_repos` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`rid` text NOT NULL,
	`app_id` integer,
	`name` text NOT NULL,
	`default_branch` text DEFAULT 'main' NOT NULL,
	`visibility` text DEFAULT 'public' NOT NULL,
	`creator_did` text,
	`whitehat_policy_hash` text,
	`whitehat_anchor_height` integer,
	`base_edition_token_id` text,
	`parent_edition_token_id` text,
	`parent_rid` text,
	`last_synced_at` integer,
	`peer_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `radicle_repos_rid_unique` ON `radicle_repos` (`rid`);--> statement-breakpoint
CREATE INDEX `radicle_repos_app_id_idx` ON `radicle_repos` (`app_id`);--> statement-breakpoint
CREATE INDEX `radicle_repos_parent_rid_idx` ON `radicle_repos` (`parent_rid`);--> statement-breakpoint
CREATE TABLE `radicle_trusted_dids` (
	`did` text PRIMARY KEY NOT NULL,
	`label` text,
	`trust_level` text DEFAULT 'manual-review' NOT NULL,
	`added_at` integer DEFAULT (unixepoch()) NOT NULL,
	`notes` text
);
--> statement-breakpoint
CREATE INDEX `radicle_trusted_dids_level_idx` ON `radicle_trusted_dids` (`trust_level`);--> statement-breakpoint
CREATE TABLE `sovereign_model_cids` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`cid` text NOT NULL,
	`model_name` text NOT NULL,
	`version` text NOT NULL,
	`sha256` text NOT NULL,
	`size_bytes` integer DEFAULT 0 NOT NULL,
	`publisher_did` text,
	`celestia_height` integer,
	`celestia_commitment` text,
	`celestia_namespace` text,
	`pinned_locally` integer DEFAULT false NOT NULL,
	`metadata_json` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sovereign_model_cids_cid_unique` ON `sovereign_model_cids` (`cid`);--> statement-breakpoint
CREATE INDEX `sovereign_model_cids_name_idx` ON `sovereign_model_cids` (`model_name`);--> statement-breakpoint
CREATE INDEX `sovereign_model_cids_publisher_idx` ON `sovereign_model_cids` (`publisher_did`);--> statement-breakpoint
CREATE TABLE `whitehat_anchor_log` (
	`id` text PRIMARY KEY NOT NULL,
	`rid` text NOT NULL,
	`event_type` text NOT NULL,
	`signer_did` text NOT NULL,
	`manifest_hash` text NOT NULL,
	`signature` text,
	`celestia_height` integer,
	`celestia_tx_hash` text,
	`celestia_namespace` text,
	`celestia_commitment` text,
	`audit_report_json` text,
	`anchored_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `whitehat_anchor_log_rid_idx` ON `whitehat_anchor_log` (`rid`);--> statement-breakpoint
CREATE INDEX `whitehat_anchor_log_signer_idx` ON `whitehat_anchor_log` (`signer_did`);