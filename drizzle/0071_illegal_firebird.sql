CREATE TABLE `video_projects` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text DEFAULT 'Untitled Project' NOT NULL,
	`timeline_json` text,
	`thumbnail_path` text,
	`rendered_video_id` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
