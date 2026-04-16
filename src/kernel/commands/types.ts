import type { Logger, UserMessage } from "@/shared";

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
  logger: Logger;
}

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
  ): Promise<string>;
}
