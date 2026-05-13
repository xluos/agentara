import {
  createLogger,
  extractTextContent,
  inlineMentions,
  type Logger,
  type Message,
} from "@/shared";

import type { SessionWriter } from "./session-writer";

/**
 * Writes session messages to Pino logger.
 */
export class SessionLogWriter implements SessionWriter {
  constructor(
    readonly sessionId: string,
    options?: { logLevel?: string },
  ) {
    this._logger = createLogger(`session-${sessionId}`);
    if (options?.logLevel) {
      this._logger.level = options.logLevel;
    }
  }

  write(message: Message): void {
    switch (message.role) {
      case "system":
        this._logger.debug(`SYSTEM: ${message.subtype}`);
        break;
      case "user":
        this._logger.debug(
          `USER: ${inlineMentions(extractTextContent(message), message.mentions)}`,
        );
        break;
      case "assistant":
        this._logger.debug(
          `ASSISTANT: ${extractTextContent(message, {
            includeToolUse: true,
            includeThinking: true,
          })}`,
        );
        break;
      case "tool":
        this._logger.debug(
          `TOOL: ${extractTextContent(message, { includeToolUse: true })}`,
        );
        break;
    }
  }

  private _logger: Logger;
}
