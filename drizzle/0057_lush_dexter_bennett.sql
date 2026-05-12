CREATE TABLE `hyper_anchor_checkpoints` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`topic_key` text NOT NULL,
	`length` integer NOT NULL,
	`tree_hash_hex` text NOT NULL,
	`celestia_height` integer,
	`celestia_commitment` text,
	`anchored_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `hyper_peers` (
	`public_key_hex` text PRIMARY KEY NOT NULL,
	`did` text,
	`topics_json` text DEFAULT '[]',
	`status` text DEFAULT 'active' NOT NULL,
	`first_seen_at` integer DEFAULT (unixepoch()) NOT NULL,
	`last_seen_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `hyper_topics` (
	`key` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`subject_id` text NOT NULL,
	`discovery_key_hex` text NOT NULL,
	`core_type` text NOT NULL,
	`writer_key_hex` text,
	`joined_at` integer DEFAULT (unixepoch()) NOT NULL,
	`last_seen_at` integer
);
