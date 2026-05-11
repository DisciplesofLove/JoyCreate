CREATE TABLE `blueprint_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`blueprint_id` text NOT NULL,
	`blueprint_version` text NOT NULL,
	`manifest_hash` text NOT NULL,
	`agent_did` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`current_node_id` text,
	`node_state_json` text DEFAULT '{}',
	`input_json` text,
	`output_json` text,
	`error` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	`completed_at` integer
);
