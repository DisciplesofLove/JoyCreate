ALTER TABLE `os_activities` ADD `current_step_id` text;--> statement-breakpoint
ALTER TABLE `os_activities` ADD `step_state_json` text;--> statement-breakpoint
ALTER TABLE `os_activities` ADD `input_json` text;--> statement-breakpoint
ALTER TABLE `os_activities` ADD `attempt` integer DEFAULT 0 NOT NULL;