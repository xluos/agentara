import type { Logger, UserMessage } from "@/shared";

import type { FeishuMessageChannel } from "../../community/feishu/messaging/message-channel";
import type { Card } from "../../community/feishu/messaging/types";
import type { SessionManager } from "../sessioning";
import type { GroupWorkspaceStore } from "../workspaces";

/**
 * Parsed slash command from an inbound message.
 * `name` is lowercase; `args` is whitespace-split and preserves order.
 */
export interface ParsedCommand {
  name: string;
  args: string[];
  raw: string;
}

/** Execution context passed to a command handler. */
export interface CommandContext {
  message: UserMessage;
  args: string[];
  raw: string;
  workspaceStore: GroupWorkspaceStore;
  /**
   * All active Feishu channels, keyed by id. Handlers that need to call SDK
   * methods (e.g. `/ungroup` deleting a chat, `/allow` mutating the
   * whitelist) look up the originating channel via `message.channel_id`.
   */
  feishuChannels: Map<string, FeishuMessageChannel>;
  /**
   * Read-only access to persisted session metadata, used by introspection
   * commands (e.g. `/topic`) to surface agent_type / runner_session_id.
   */
  sessionManager: SessionManager;
  taskDispatcher: {
    // eslint-disable-next-line no-unused-vars
    getActiveTaskStatusForSession(sessionId: string): "running" | "pending" | undefined;
  };
  // eslint-disable-next-line no-unused-vars
  readSessionUsageSnapshot(sessionId: string):
    | { message_id: string; used_tokens: number; model?: string }
    | undefined;
  logger: Logger;
}

export interface CardCommandResult {
  kind: "card";
  card: Card;
  fallback_text: string;
}

/**
 * Result for commands whose real work is slow (e.g. `/clone` running
 * `git clone`). The kernel posts `initial` immediately as a "pending" card,
 * then runs `run()` in the background and patches the SAME message with the
 * returned card (pending → done/failed). Any error thrown by `run()` is
 * caught by the kernel and rendered as a failure card, so a slow command can
 * never crash the process or leave the user staring at a stuck card.
 */
export interface DeferredCardCommandResult {
  kind: "deferred_card";
  /** Card shown right away, before the slow work starts. */
  initial: Card;
  /** Plain-text fallback used when the channel cannot render cards. */
  fallback_text: string;
  /** Background work; resolves to the final card used to patch the message. */
  run(): Promise<Card>;
}

export type CommandResult =
  | string
  | CardCommandResult
  | DeferredCardCommandResult;

/** A gateway-level command that bypasses the LLM entirely. */
export interface CommandHandler {
  /** Command name without the leading slash (lowercase). */
  readonly name: string;
  /** One-line help text shown by `/help`. */
  readonly description: string;
  /** Run the command; return reply text that will be sent to the chat. */
  execute(
    // eslint-disable-next-line no-unused-vars
    ctx: CommandContext,
  ): Promise<CommandResult>;
}
