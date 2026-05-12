CREATE TABLE `copilot_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`user_prompt` text NOT NULL,
	`intent_json` text,
	`kind` text NOT NULL,
	`tool_name` text,
	`branch_name` text,
	`diff_path` text,
	`claude_cost_usd` text DEFAULT '0' NOT NULL,
	`summary` text,
	`output` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`approved_by` text,
	`error_message` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	`completed_at` integer
);
--> statement-breakpoint
CREATE INDEX `idx_copilot_status` ON `copilot_jobs` (`status`);--> statement-breakpoint
CREATE INDEX `idx_copilot_kind` ON `copilot_jobs` (`kind`);--> statement-breakpoint
CREATE INDEX `idx_copilot_created` ON `copilot_jobs` (`created_at`);