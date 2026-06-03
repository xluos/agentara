import type EventEmitter from "eventemitter3";

import type { CardActionPayload, MessageChannel } from "./message-channel";
import type { AssistantMessage, CardFooterStats, UserMessage } from "./types";

/** Event types emitted by a message gateway. */
export interface MessageGatewayEventTypes {
  // eslint-disable-next-line no-unused-vars
  "message:inbound": (message: UserMessage) => void;
  // eslint-disable-next-line no-unused-vars
  "message:recalled": (messageId: string, channelId: string) => void;
  // eslint-disable-next-line no-unused-vars
  "card:action": (payload: CardActionPayload) => void;
}

/**
 * A gateway that manages multiple message channels, routes outbound messages
 * to the correct channel, and emits unified inbound events.
 */
export interface MessageGateway extends EventEmitter<MessageGatewayEventTypes> {
  /** Register a message channel with the gateway. */
  // eslint-disable-next-line no-unused-vars
  registerChannel(channel: MessageChannel): void;

  /** Start the gateway and all registered channels. */
  start(): Promise<void>;

  /**
   * Post a new assistant message without replying to an existing message.
   * @param message - The assistant message to post (without id).
   * @param options - Optional settings. `channelId` bypasses the session→channel
   *   DB lookup; use it when the session row may not exist yet (e.g. gateway
   *   commands that reply before any Session is created).
   * @returns The posted message with id assigned.
   */
  postMessage(
    // eslint-disable-next-line no-unused-vars
    message: Omit<AssistantMessage, "id">,
    // eslint-disable-next-line no-unused-vars
    options?: { channelId?: string },
  ): Promise<AssistantMessage>;

  /**
   * Reply to an existing message.
   * @param messageId - ID of the message to reply to.
   * @param message - The assistant message to send (without id).
   * @param options - Optional settings.
   *   - `channelId` bypasses the session→channel DB lookup; use it when the
   *     session row may not exist yet.
   *   - `replyInThread` toggles whether the reply opens a new Feishu topic
   *     (default `true`, matches the session flow). Pass `false` for one-shot
   *     replies like slash commands so they show up inline in the chat list.
   * @returns The sent message with id assigned.
   */
  replyMessage(
    // eslint-disable-next-line no-unused-vars
    messageId: string,
    // eslint-disable-next-line no-unused-vars
    message: Omit<AssistantMessage, "id">,
    // eslint-disable-next-line no-unused-vars
    options?: {
      streaming?: boolean;
      channelId?: string;
      replyInThread?: boolean;
    },
  ): Promise<AssistantMessage>;

  /**
   * Update the content of an existing message.
   * @param message - The assistant message with updated content.
   * @param options - Optional settings. `channelId` bypasses the session→channel
   *   DB lookup. `footer` carries context / quota stats for the finalized card.
   */
  updateMessageContent(
    // eslint-disable-next-line no-unused-vars
    message: AssistantMessage,
    // eslint-disable-next-line no-unused-vars
    options?: {
      streaming?: boolean;
      channelId?: string;
      footer?: CardFooterStats;
    },
  ): Promise<void>;
}
