-- Recovers the three migrations that were dropped from the journal when PR #29
-- was merged: both branches had numbered migrations 0077 and 0078, the merge
-- kept main's pair, and `0077_reflective_daimon_hellstrom`,
-- `0078_workable_puck` and `0079_glamorous_doctor_spectrum` were left as
-- unlisted .sql files that would never run.
--
-- The four `os_activities` columns from `0078_workable_puck` are not here:
-- SQLite has no `ADD COLUMN IF NOT EXISTS`, and a database that already ran the
-- branch's copies would abort this migration and everything after it. They are
-- added by the PRAGMA-guarded self-heal in src/db/index.ts instead.
CREATE TABLE IF NOT EXISTS `chat_summaries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`chat_id` integer NOT NULL,
	`up_to_message_id` integer NOT NULL,
	`summary` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `chat_summaries_chat_id_unique` ON `chat_summaries` (`chat_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `training_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`base_model_id` text NOT NULL,
	`method` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`progress` integer DEFAULT 0 NOT NULL,
	`current_epoch` integer DEFAULT 0,
	`total_epochs` integer,
	`current_step` integer,
	`total_steps` integer,
	`current_loss` integer,
	`gpu_memory_used_mb` integer,
	`dataset_id` text,
	`dataset_path` text,
	`output_path` text NOT NULL,
	`hyperparameters_json` text,
	`pid` integer,
	`activity_id` text,
	`registry_entry_id` text,
	`error` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	`started_at` integer,
	`completed_at` integer
);
