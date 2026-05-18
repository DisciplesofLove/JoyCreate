CREATE TABLE `genius_core_adapter_scores` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`adapter_id` text NOT NULL,
	`slot_cid` text,
	`score` real NOT NULL,
	`sample_count` integer NOT NULL,
	`outcome` text DEFAULT 'applied' NOT NULL,
	`baseline_score` real,
	`evaluated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `genius_core_eval_sets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`prompts` text NOT NULL,
	`expected_keywords` text NOT NULL,
	`last_score` real,
	`last_evaluated_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `genius_core_eval_sets_project_id_unique` ON `genius_core_eval_sets` (`project_id`);