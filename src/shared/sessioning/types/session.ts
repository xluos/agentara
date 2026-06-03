import { z } from "zod";

/**
 * A persisted session record that tracks session metadata.
 *
 * Message content lives in `.jsonl` files — this entity only represents
 * the session envelope (who, where, when).
 */
export const Session = z.object({
  /** Unique session identifier. */
  id: z.string(),
  /** The agent runner type, e.g. `"claude-code"`. */
  agent_type: z.string(),
  /** Working directory the session was created with. */
  cwd: z.string(),
  /** The channel id this session belongs to, or null/undefined for legacy sessions. */
  channel_id: z.string().optional().nullable(),
  /** Feishu chat_id owning this session; null for non-Feishu sessions. */
  chat_id: z.string().optional().nullable(),
  /** Feishu topic/thread id for this session; null for non-threaded sessions. */
  thread_id: z.string().optional().nullable(),
  /** The text content of the session's first inbound message. */
  first_message: z.string(),
  /** Runner-specific session/thread id (e.g. Codex thread id), if available. */
  runner_session_id: z.string().optional().nullable(),
  /** Whether this session was created via handoff from an external Claude Code instance. */
  handoff: z.boolean().default(false),
  /** Epoch milliseconds of the most recent message, or null if no messages yet. */
  last_message_created_at: z.number().nullable(),
  /** Epoch milliseconds when the session was created. */
  created_at: z.number(),
  /** Epoch milliseconds when the session was last updated. */
  updated_at: z.number(),
});
export interface Session extends z.infer<typeof Session> {}
