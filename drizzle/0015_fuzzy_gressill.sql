ALTER TABLE `workspaces` ADD `last_active_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE `workspaces` SET `last_active_at` = `updated_at`;
