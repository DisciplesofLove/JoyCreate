CREATE TABLE `unified_identities` (
	`did` text PRIMARY KEY NOT NULL,
	`is_current` integer DEFAULT false NOT NULL,
	`identity_json` text NOT NULL,
	`ens_records_json` text DEFAULT '[]' NOT NULL,
	`jns_records_json` text DEFAULT '[]' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `unified_identity_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` text NOT NULL,
	`did` text NOT NULL,
	`type` text NOT NULL,
	`description` text NOT NULL,
	`triggered_by` text NOT NULL,
	`data_hash` text NOT NULL,
	`changes_json` text,
	`metadata_json` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `unified_identity_events_event_id_unique` ON `unified_identity_events` (`event_id`);