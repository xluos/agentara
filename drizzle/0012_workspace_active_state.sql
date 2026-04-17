-- Move active_repo/active_branch from `group_workspaces` up to `workspaces`.
-- Only one `.git/HEAD` exists per cloned repo, so the "active" state is a
-- workspace-on-disk property, not a per-binding property. Multiple groups
-- sharing a workspace should see the same active state.
ALTER TABLE `workspaces` ADD `active_repo` text;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `active_branch` text;--> statement-breakpoint
-- Backfill: for each workspace, copy the active state from any existing
-- binding. Pre-migration each workspace maps 1:1 to a chat, so any binding
-- row is authoritative; if a shared workspace somehow exists, prefer the
-- most recently updated binding.
UPDATE `workspaces`
SET
    `active_repo` = (
        SELECT `gw`.`active_repo`
        FROM `group_workspaces` AS `gw`
        WHERE `gw`.`workspace_id` = `workspaces`.`id`
        ORDER BY `gw`.`updated_at` DESC
        LIMIT 1
    ),
    `active_branch` = (
        SELECT `gw`.`active_branch`
        FROM `group_workspaces` AS `gw`
        WHERE `gw`.`workspace_id` = `workspaces`.`id`
        ORDER BY `gw`.`updated_at` DESC
        LIMIT 1
    )
WHERE EXISTS (
    SELECT 1
    FROM `group_workspaces` AS `gw`
    WHERE `gw`.`workspace_id` = `workspaces`.`id`
);--> statement-breakpoint
ALTER TABLE `group_workspaces` DROP COLUMN `active_repo`;--> statement-breakpoint
ALTER TABLE `group_workspaces` DROP COLUMN `active_branch`;
