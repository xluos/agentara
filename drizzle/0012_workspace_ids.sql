CREATE TABLE `workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`path` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspaces_path_unique` ON `workspaces` (`path`);
--> statement-breakpoint
WITH RECURSIVE `workspace_name_parts`(`chat_id`, `path`, `tail`) AS (
	SELECT
		`chat_id`,
		rtrim(`workspace_path`, '/'),
		rtrim(`workspace_path`, '/')
	FROM `group_workspaces`
	UNION ALL
	SELECT
		`chat_id`,
		`path`,
		substr(`tail`, instr(`tail`, '/') + 1)
	FROM `workspace_name_parts`
	WHERE instr(`tail`, '/') > 0
)
INSERT OR IGNORE INTO `workspaces` (`id`, `name`, `path`, `created_at`, `updated_at`)
SELECT
	'ws_' || lower(hex(randomblob(6))),
	COALESCE(NULLIF(`parts`.`tail`, ''), '_workspace'),
	`parts`.`path`,
	`gw`.`created_at`,
	`gw`.`updated_at`
FROM `workspace_name_parts` AS `parts`
JOIN `group_workspaces` AS `gw` ON `gw`.`chat_id` = `parts`.`chat_id`
WHERE instr(`parts`.`tail`, '/') = 0;
--> statement-breakpoint
ALTER TABLE `group_workspaces` RENAME TO `group_workspaces__old`;
--> statement-breakpoint
CREATE TABLE `group_workspaces` (
	`chat_id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`active_repo` text,
	`active_branch` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `group_workspaces` (
	`chat_id`,
	`workspace_id`,
	`active_repo`,
	`active_branch`,
	`created_at`,
	`updated_at`
)
SELECT
	`old`.`chat_id`,
	`ws`.`id`,
	`old`.`active_repo`,
	`old`.`active_branch`,
	`old`.`created_at`,
	`old`.`updated_at`
FROM `group_workspaces__old` AS `old`
JOIN `workspaces` AS `ws` ON `ws`.`path` = `old`.`workspace_path`;
--> statement-breakpoint
DROP TABLE `group_workspaces__old`;
