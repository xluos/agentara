import { z } from "zod";

import {
  ImageUrlMessageContent,
  TextMessageContent,
  ThinkingMessageContent,
  ToolUseMessageContent,
  ToolResultMessageContent,
} from "./contents";
import { MessageRole } from "./roles";

/**
 * The base object of message.
 */
const BaseMessage = z.object({
  /**
   * The id of the message.
   */
  id: z.string(),

  /**
   * The id of the session the message belongs to.
   */
  session_id: z.string(),

  /**
   * The role of the message sender.
   */
  role: MessageRole,
});
interface BaseMessage extends z.infer<typeof BaseMessage> {}

/**
 * The system message.
 */
export const SystemMessage = BaseMessage.extend({
  role: z.literal("system"),
  subtype: z.string(),
});
export interface SystemMessage extends z.infer<typeof SystemMessage> {}

/**
 * A single @-mention inside an inbound message. Provider-agnostic shape —
 * Feishu maps these from the event's `mentions` array; other channels may
 * leave the list empty. Consumers (e.g. `/group`, `/allow`) use this to
 * resolve `@_user_N` placeholders in the text content back to open_ids.
 */
export const MessageMention = z.object({
  /** Placeholder substring in the text, e.g. `@_user_0` for Feishu. */
  key: z.string(),
  /** Provider-specific open_id of the mentioned user. */
  open_id: z.string(),
  /** Display name at event time (best-effort). */
  name: z.string().optional(),
});
export interface MessageMention extends z.infer<typeof MessageMention> {}

/**
 * The user message.
 */
export const UserMessage = BaseMessage.extend({
  role: z.literal("user"),
  /** The channel id this message originated from. */
  channel_id: z.string().optional(),
  /** Feishu chat_id, when this message originated from a Feishu channel. */
  chat_id: z.string().optional(),
  /**
   * Feishu chat type: "group" for group chats, "single" for 1:1 (P2P).
   * Only meaningful when `chat_id` is set. Left undefined for non-Feishu
   * sources so consumers fall back to "permissive" defaults.
   */
  chat_type: z.enum(["group", "single"]).optional(),
  /** Feishu topic/thread id, when the message is inside a topic. */
  thread_id: z.string().optional(),
  /** Provider-specific open_id of the sender (e.g. Feishu open_id). */
  sender_open_id: z.string().optional(),
  /**
   * @-mentions carried from the source event, in order. Empty/undefined when
   * the channel doesn't expose mentions or when no users were @-tagged.
   */
  mentions: z.array(MessageMention).optional(),
  content: z.array(
    z.discriminatedUnion("type", [
      TextMessageContent,
      ImageUrlMessageContent,
      ToolResultMessageContent,
    ]),
  ),
});
export interface UserMessage extends z.infer<typeof UserMessage> {}

/**
 * The assistant message.
 */
export const AssistantMessage = BaseMessage.extend({
  role: z.literal("assistant"),
  content: z.array(
    z.discriminatedUnion("type", [
      TextMessageContent,
      ThinkingMessageContent,
      ImageUrlMessageContent,
      ToolUseMessageContent,
    ]),
  ),
});
export interface AssistantMessage extends z.infer<typeof AssistantMessage> {}

/**
 * The tool message which contains the result of a tool use.
 */
export const ToolMessage = BaseMessage.extend({
  role: z.literal("tool"),
  content: z.array(z.discriminatedUnion("type", [ToolResultMessageContent])),
});
export interface ToolMessage extends z.infer<typeof ToolMessage> {}

/**
 * The general message.
 */
export const Message = z.discriminatedUnion("role", [
  SystemMessage,
  UserMessage,
  AssistantMessage,
  ToolMessage,
]);
export type Message =
  | SystemMessage
  | UserMessage
  | AssistantMessage
  | ToolMessage;
