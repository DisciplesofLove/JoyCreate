CREATE TABLE `api_endpoints` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`agent_id` integer,
	`config_json` text,
	`price_per_call_wei` text DEFAULT '0' NOT NULL,
	`price_per_k_token_wei` text DEFAULT '0' NOT NULL,
	`rate_limit_per_min` integer DEFAULT 60 NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_endpoints_slug_unique` ON `api_endpoints` (`slug`);--> statement-breakpoint
CREATE TABLE `api_keys` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`endpoint_id` integer NOT NULL,
	`name` text NOT NULL,
	`key_prefix` text NOT NULL,
	`key_hash` text NOT NULL,
	`rate_limit_per_min` integer,
	`monthly_call_quota` integer,
	`revoked_at` integer,
	`last_used_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_key_hash_unique` ON `api_keys` (`key_hash`);--> statement-breakpoint
CREATE TABLE `api_usage_records` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`endpoint_id` integer NOT NULL,
	`api_key_id` integer NOT NULL,
	`bytes_in` integer DEFAULT 0 NOT NULL,
	`bytes_out` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`latency_ms` integer DEFAULT 0 NOT NULL,
	`status_code` integer NOT NULL,
	`charged_wei` text DEFAULT '0' NOT NULL,
	`error_message` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
