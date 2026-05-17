CREATE TABLE `edit_log_entries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`file_id` text NOT NULL,
	`op` text NOT NULL,
	`range` text NOT NULL,
	`text_hash` text,
	`text_length` integer DEFAULT 0 NOT NULL,
	`sequence` integer NOT NULL,
	`occurred_at_ms` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
