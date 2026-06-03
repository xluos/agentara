CREATE TABLE `group_workspaces` (
	`chat_id` text PRIMARY KEY NOT NULL,
	`workspace_path` text NOT NULL,
	`active_repo` text,
	`active_branch` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `sessions` ADD `chat_id` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `thread_id` text;