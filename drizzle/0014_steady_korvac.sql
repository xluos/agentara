CREATE TABLE `feishu_bot_groups` (
	`chat_id` text PRIMARY KEY NOT NULL,
	`channel_id` text NOT NULL,
	`chat_name` text NOT NULL,
	`creator_open_id` text NOT NULL,
	`created_at` integer NOT NULL
);
