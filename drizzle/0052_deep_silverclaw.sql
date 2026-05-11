CREATE TABLE `whitehat_mcp_allowlist` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`server_name` text NOT NULL,
	`tool_name` text NOT NULL,
	`invocation_hash` text NOT NULL,
	`label` text,
	`scope` text DEFAULT 'always' NOT NULL,
	`granted_by` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`last_used_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `whitehat_mcp_allowlist_server_name_tool_name_invocation_hash_unique` ON `whitehat_mcp_allowlist` (`server_name`,`tool_name`,`invocation_hash`);--> statement-breakpoint
CREATE TABLE `whitehat_mcp_audit` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`server_name` text NOT NULL,
	`tool_name` text NOT NULL,
	`invocation_hash` text NOT NULL,
	`args_json` text,
	`decision` text NOT NULL,
	`reason` text,
	`rpc_id` text,
	`blueprint_run_id` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
