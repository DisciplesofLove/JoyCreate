CREATE TABLE `social_agent_settings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`auto_generate` integer DEFAULT false NOT NULL,
	`auto_publish` integer DEFAULT false NOT NULL,
	`auto_reply` integer DEFAULT false NOT NULL,
	`default_tone` text,
	`brand_voice` text,
	`engagement_scan_cron` text,
	`engagement_scan_schedule_id` text,
	`max_posts_per_day` integer DEFAULT 10 NOT NULL,
	`max_replies_per_day` integer DEFAULT 50 NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `social_campaigns` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`status` text DEFAULT 'active' NOT NULL,
	`topics_json` text NOT NULL,
	`tone` text,
	`audience` text,
	`cadence_json` text,
	`target_account_ids_json` text NOT NULL,
	`auto_generate` integer DEFAULT false NOT NULL,
	`auto_publish` integer DEFAULT false NOT NULL,
	`generation_schedule_id` text,
	`start_at` integer,
	`end_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `social_engagement_replies` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`engagement_id` integer NOT NULL,
	`text` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`source` text DEFAULT 'manual' NOT NULL,
	`external_reply_id` text,
	`error_message` text,
	`approved_at` integer,
	`sent_at` integer,
	`ai_model` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `social_engagements` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`post_target_id` integer,
	`type` text NOT NULL,
	`external_id` text NOT NULL,
	`external_parent_id` text,
	`author_handle` text,
	`author_display_name` text,
	`text` text NOT NULL,
	`permalink` text,
	`sentiment` text,
	`status` text DEFAULT 'new' NOT NULL,
	`raw` text,
	`received_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `social_metrics` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`post_target_id` integer NOT NULL,
	`impressions` integer DEFAULT 0 NOT NULL,
	`likes` integer DEFAULT 0 NOT NULL,
	`comments` integer DEFAULT 0 NOT NULL,
	`shares` integer DEFAULT 0 NOT NULL,
	`clicks` integer DEFAULT 0 NOT NULL,
	`captured_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `social_post_targets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`post_id` integer NOT NULL,
	`account_id` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`external_post_id` text,
	`permalink` text,
	`error_message` text,
	`posted_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `social_posts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`campaign_id` integer,
	`content_json` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`source` text DEFAULT 'manual' NOT NULL,
	`scheduled_for` integer,
	`schedule_id` text,
	`approved_at` integer,
	`approved_by` text,
	`ai_model` text,
	`ai_prompt` text,
	`error_message` text,
	`posted_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
DROP TABLE `social_scheduled_posts`;--> statement-breakpoint
ALTER TABLE `social_accounts` ADD `auto_reply` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `social_accounts` ADD `token_status` text DEFAULT 'none' NOT NULL;