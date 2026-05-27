CREATE TABLE `chat_plans` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`chat_id` integer NOT NULL,
	`goal` text NOT NULL,
	`phases` text NOT NULL,
	`current_phase_index` integer DEFAULT -1 NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`started_at` integer,
	`completed_at` integer,
	`last_error` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `chat_plans_chat_id_unique` ON `chat_plans` (`chat_id`);--> statement-breakpoint
ALTER TABLE `chats` ADD `chat_mode` text;