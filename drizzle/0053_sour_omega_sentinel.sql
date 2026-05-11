CREATE TABLE `gauntlet_audit` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` text NOT NULL,
	`stage` text NOT NULL,
	`decision` text NOT NULL,
	`reason` text,
	`score` real,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `gauntlet_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` text NOT NULL,
	`blueprint_id` text,
	`session_id` text,
	`target_url` text NOT NULL,
	`intent` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`markdown_cid` text,
	`markdown_path` text,
	`integrity_score` real,
	`duration_ms` integer,
	`error_code` text,
	`error_message` text,
	`screenshot_path` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`completed_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `gauntlet_runs_run_id_unique` ON `gauntlet_runs` (`run_id`);--> statement-breakpoint
CREATE TABLE `gauntlet_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`origin_pattern` text NOT NULL,
	`last_used_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
