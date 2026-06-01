import type EventEmitter from "eventemitter3";

import type { AssistantMessage, CardFooterStats, UserMessage } from "./types";

/**
 * Payload delivered when a user interacts with an interactive card. The
 * channel normalizes the provider-specific event (for Feishu:
 * `card.action.trigger`) into this shape before re-emitting.
 */
export interface CardActionPayload {
  /** ID of the card message the user interacted with. */
  message_id: string;
  /** Channel that delivered the event. */
  channel_id: string;
  /** Provider-specific chat/group identifier, if applicable. */
  chat_id?: string;
  /** open_id of the user who clicked. */
  operator_open_id: string;
  /**
   * Action discriminator. For our own cards, this is set via
   * `behaviors[].value.action` on the triggering element. Commands use it to
   * route the event (e.g. `"setup_submit"`).
   */
  action_name: string;
  /** The full `behaviors[].value` dict, passed through verbatim. */
  value: Record<string, unknown>;
  /**
   * For `action_type: "form_submit"` — values of every named field inside the
   * enclosing form (input/checker/select). Empty for non-form actions.
   */
  form_value: Record<string, unknown>;
}

/** Event types emitted by a message channel. */
export interface MessageChannelEventTypes {
  // eslint-disable-next-line no-unused-vars
  "message:inbound": (message: UserMessage) => void;
  // eslint-disable-next-line no-unused-vars
  "message:recalled": (messageId: string, channelId: string) => void;
  // eslint-disable-next-line no-unused-vars
  "card:action": (payload: CardActionPayload) => void;
}

/** Abstract message channel for sending and receiving messages. */
export interface MessageChannel extends EventEmitter {
  /** Channel ID. */
  readonly id: string;

  /** Channel type identifier (e.g. "feishu"). */
  readonly type: string;

  /** Start the channel and begin listening for inbound messages. */
  start(): Promise<void>;

  /**
   * Post a new assistant message without replying to an existing message.
   * @param message - The assistant message to post (without id).
   * @returns The posted message with id assigned.
   */
  // eslint-disable-next-line no-unused-vars
  postMessage(message: Omit<AssistantMessage, "id">): Promise<AssistantMessage>;

  /**
   * Reply to an existing message.
   * @param messageId - ID of the message to reply to.
   * @param message - The assistant message to send (without id).
   * @param options - Optional settings.
   *   - `streaming`: card is part of a stream; skip text rendering until final.
   *   - `replyInThread`: Feishu-specific — default `true`. Set `false` for
   *     one-shot replies (e.g. slash commands) that should appear inline in
   *     the chat instead of opening a new topic.
   * @returns The sent message with id assigned.
   */
  replyMessage(
    // eslint-disable-next-line no-unused-vars
    messageId: string,
    // eslint-disable-next-line no-unused-vars
    message: Omit<AssistantMessage, "id">,
    // eslint-disable-next-line no-unused-vars
    options?: { streaming?: boolean; replyInThread?: boolean },
  ): Promise<AssistantMessage>;

  /**
   * Update the content of an existing message.
   * @param message - The assistant message with updated content.
   * @param options - Optional settings.
   *   - `streaming`: card is mid-stream; skip final-only rendering.
   *   - `footer`: context / quota stats to render at the bottom of a
   *     finalized card. Ignored while streaming.
   */
  updateMessageContent(
    // eslint-disable-next-line no-unused-vars
    message: AssistantMessage,
    // eslint-disable-next-line no-unused-vars
    options?: { streaming?: boolean; footer?: CardFooterStats },
  ): Promise<void>;
}
