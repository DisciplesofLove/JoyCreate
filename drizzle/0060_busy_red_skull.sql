CREATE TABLE `agent_rental_earnings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`agent_ref` text NOT NULL,
	`agent_name` text NOT NULL,
	`renter_address` text,
	`amount_usdc` text NOT NULL,
	`tx_hash` text,
	`block_number` integer,
	`earned_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `domain_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` text NOT NULL,
	`payload` text NOT NULL,
	`occurred_at` integer DEFAULT (unixepoch()) NOT NULL,
	`source_tx_hash` text,
	`source_log_index` integer,
	`version` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_did` text,
	`category` text NOT NULL,
	`priority` text DEFAULT 'info' NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`action_url` text,
	`action_label` text,
	`source_event_id` integer,
	`read_at` integer,
	`dismissed_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`source_event_id`) REFERENCES `domain_events`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `on_chain_drop_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_name` text NOT NULL,
	`contract_address` text NOT NULL,
	`tx_hash` text NOT NULL,
	`log_index` integer NOT NULL,
	`block_number` integer NOT NULL,
	`args_json` text NOT NULL,
	`observed_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `subscription_earnings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`plan_ref` text NOT NULL,
	`plan_name` text NOT NULL,
	`subscriber_address` text,
	`amount_usdc` text NOT NULL,
	`period_start` integer,
	`period_end` integer,
	`tx_hash` text,
	`earned_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
ALTER TABLE `image_studio_images` ADD `provenance_json` text;--> statement-breakpoint
ALTER TABLE `video_studio_videos` ADD `provenance_json` text;