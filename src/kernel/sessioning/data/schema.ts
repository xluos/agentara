import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Persisted session records that track session metadata across restarts.
 *
 * Message content is still stored in `.jsonl` files — this table only
 * holds the session envelope (who, where, when).
 */
export const sessions = sqliteTable("sessions", {
  /** Unique session identifier. */
  id: text("id").primaryKey(),
  /** The agent runner type, e.g. `"claude-code"`. */
  agent_type: text("agent_type").notNull(),
  /** Working directory the session was created with. */
  cwd: text("cwd").notNull(),
  /** The channel id this session belongs to, or null for legacy sessions. */
  channel_id: text("channel_id"),
  /** Feishu chat_id owning this session. Null for non-Feishu or legacy. */
  chat_id: text("chat_id"),
  /** Feishu topic/thread id for this session. Null for non-threaded. */
  thread_id: text("thread_id"),
  /** The text content of the session's first inbound message. */
  first_message: text("first_message").notNull().default(""),
  /** Runner-specific session/thread id (e.g. Codex thread id) for resume. */
  runner_session_id: text("runner_session_id"),
  /** Epoch milliseconds of the most recent message, or null if no messages yet. */
  last_message_created_at: integer("last_message_created_at"),
  /** Epoch milliseconds when the session was created. */
  created_at: integer("created_at").notNull(),
  /** Epoch milliseconds when the session was last updated. */
  updated_at: integer("updated_at").notNull(),
});

/**
 * Persisted group↔workspace bindings. One row per Feishu group that has been
 * bound via `/bind` or `/setup`. Absence of a row means the group is unbound
 * and falls back to the default workspace.
 *
 * workspace_path is always `$AGENTARA_HOME/workspaces/<chat_id>/`; stored to
 * make the value explicit and survive config path changes.
 */
export const groupWorkspaces = sqliteTable("group_workspaces", {
  /** Feishu chat id. */
  chat_id: text("chat_id").primaryKey(),
  /** Absolute path of the group's workspace directory. */
  workspace_path: text("workspace_path").notNull(),
  /** Basename of the currently focused repo under workspace_path, or null. */
  active_repo: text("active_repo"),
  /** Git branch to check out in the active repo on dispatch, or null. */
  active_branch: text("active_branch"),
  /** Epoch milliseconds when the binding was created. */
  created_at: integer("created_at").notNull(),
  /** Epoch milliseconds when the binding was last updated. */
  updated_at: integer("updated_at").notNull(),
});
