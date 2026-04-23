import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

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
 * Persisted workspace registry. A workspace has its own stable id so multiple
 * Feishu groups can bind to the same underlying directory while preserving a
 * human-readable name/path for display.
 *
 * `active_repo` and `active_branch` live here (not on the binding) because
 * only one `.git/HEAD` exists per cloned repo — the "active" state is a
 * property of the workspace on disk, shared by any group bound to it.
 */
export const workspaces = sqliteTable(
  "workspaces",
  {
    /** Stable workspace id used by `/bind <workspace-id>`. */
    id: text("id").primaryKey(),
    /** Human-readable workspace name (also the directory basename today). */
    name: text("name").notNull(),
    /** Absolute path of the workspace root on disk. */
    path: text("path").notNull(),
    /** Basename of the currently focused repo under `path`, or null. */
    active_repo: text("active_repo"),
    /** Git branch to check out in the active repo on dispatch, or null. */
    active_branch: text("active_branch"),
    /** Epoch milliseconds when the workspace was created. */
    created_at: integer("created_at").notNull(),
    /** Epoch milliseconds when the workspace was last updated. */
    updated_at: integer("updated_at").notNull(),
    /**
     * Epoch milliseconds of the last time any chat bound to this workspace
     * dispatched a message, re-bound, or mutated active state. Distinct from
     * `updated_at` (which only moves on explicit row writes): this tracks
     * usage, so the `/setting` panel can surface dormant workspaces.
     */
    last_active_at: integer("last_active_at").notNull(),
  },
  (table) => ({
    path_unique: uniqueIndex("workspaces_path_unique").on(table.path),
  }),
);

/**
 * Persisted group↔workspace bindings. One row per Feishu group that has been
 * bound via `/bind` or `/setup`. Absence of a row means the group is unbound
 * and falls back to the default workspace.
 *
 * The binding is a thin many-to-one pointer — active repo/branch belong to
 * the workspace itself, so groups bound to the same workspace share them.
 */
export const groupWorkspaces = sqliteTable("group_workspaces", {
  /** Feishu chat id. */
  chat_id: text("chat_id").primaryKey(),
  /** Stable workspace id. */
  workspace_id: text("workspace_id").notNull(),
  /** Epoch milliseconds when the binding was created. */
  created_at: integer("created_at").notNull(),
  /** Epoch milliseconds when the binding was last updated. */
  updated_at: integer("updated_at").notNull(),
});
