CREATE TABLE `brand_kits` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`logo_url` text,
	`wordmark_url` text,
	`color_tokens` text,
	`voice_guide` text,
	`font_stack` text,
	`do_not_json` text,
	`tagline` text,
	`is_default` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
ALTER TABLE `agents` ADD `brand_kit_id` integer;