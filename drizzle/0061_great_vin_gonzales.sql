CREATE TABLE `data_lease_grants` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`chain_id` text NOT NULL,
	`contract_address` text NOT NULL,
	`lease_id` text NOT NULL,
	`listing_id` text NOT NULL,
	`token_id` text NOT NULL,
	`lessee` text NOT NULL,
	`paid_wei` text NOT NULL,
	`expires_at` text NOT NULL,
	`acc_conditions_hash` text NOT NULL,
	`relayer_status` text DEFAULT 'pending' NOT NULL,
	`relayer_error` text,
	`granted_tx_hash` text NOT NULL,
	`observed_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `data_lease_listings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`chain_id` text NOT NULL,
	`contract_address` text NOT NULL,
	`listing_id` text NOT NULL,
	`token_id` text NOT NULL,
	`creator` text NOT NULL,
	`price_wei` text NOT NULL,
	`duration_secs` text NOT NULL,
	`acc_conditions_hash` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_tx_hash` text NOT NULL,
	`observed_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `data_provenance_tokens` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`chain_id` text NOT NULL,
	`contract_address` text NOT NULL,
	`token_id` text NOT NULL,
	`creator` text NOT NULL,
	`merkle_root` text NOT NULL,
	`content_uri` text NOT NULL,
	`human_proof` text NOT NULL,
	`minted_at_chain` text NOT NULL,
	`tx_hash` text NOT NULL,
	`revoked` integer DEFAULT false NOT NULL,
	`observed_at` integer DEFAULT (unixepoch()) NOT NULL
);
