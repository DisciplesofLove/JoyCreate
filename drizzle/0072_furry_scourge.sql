ALTER TABLE `onchain_publish_bundles` ADD `shard_root_cid` text;--> statement-breakpoint
ALTER TABLE `onchain_publish_bundles` ADD `merkle_root` text;--> statement-breakpoint
ALTER TABLE `onchain_publish_bundles` ADD `content_hash` text;--> statement-breakpoint
ALTER TABLE `onchain_publish_bundles` ADD `celestia_height` integer;--> statement-breakpoint
ALTER TABLE `onchain_publish_bundles` ADD `celestia_commitment` text;--> statement-breakpoint
ALTER TABLE `onchain_publish_bundles` ADD `celestia_namespace` text;--> statement-breakpoint
ALTER TABLE `onchain_publish_bundles` ADD `provenance_token_id` text;--> statement-breakpoint
ALTER TABLE `onchain_publish_bundles` ADD `provenance_tx_hash` text;