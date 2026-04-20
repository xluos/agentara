import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Maps Feishu thread IDs to Agentara session IDs.
 *
 * Each row represents a single Feishu message thread that has been
 * associated with a session. The in-memory cache in
 * {@link FeishuMessageChannel} is the hot path; this table is the
 * durable fallback that survives restarts.
 */
export const feishuThreads = sqliteTable("feishu_threads", {
  /** The Feishu thread identifier (unique per conversation thread). */
  thread_id: text("thread_id").primaryKey(),
  /** The Agentara session identifier. */
  session_id: text("session_id").notNull(),
  /** Epoch milliseconds when the mapping was created. */
  created_at: integer("created_at").notNull(),
});

/**
 * Groups the bot itself created via the `/group` command.
 *
 * Used by `/ungroup` to (a) authorize dismissal — only the original
 * creator can tear down a group the bot made, and (b) look up groups by
 * name when the command runs in P2P without a current-chat context.
 */
export const feishuBotGroups = sqliteTable("feishu_bot_groups", {
  /** Feishu chat_id of the group created by the bot. */
  chat_id: text("chat_id").primaryKey(),
  /** Channel id that created the group (for multi-channel deployments). */
  channel_id: text("channel_id").notNull(),
  /** Display name given to the group at creation time. */
  chat_name: text("chat_name").notNull(),
  /** open_id of the user who ran `/group` — authoritative for dismissal. */
  creator_open_id: text("creator_open_id").notNull(),
  /** Epoch milliseconds when the group was created. */
  created_at: integer("created_at").notNull(),
});
