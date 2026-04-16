import { eq } from "drizzle-orm";
import EventEmitter from "eventemitter3";

import type { DrizzleDB } from "@/data";
import type {
  AssistantMessage,
  CardActionPayload,
  MessageChannel,
  MessageGateway,
  MessageGatewayEventTypes,
  UserMessage,
} from "@/shared";
import { createLogger } from "@/shared";

import { sessions } from "../sessioning/data";

/**
 * A gateway that manages multiple message channels, routes outbound messages
 * to the correct channel based on session `channel_id`, and emits unified
 * inbound events.
 */
export class MultiChannelMessageGateway
  extends EventEmitter<MessageGatewayEventTypes>
  implements MessageGateway
{
  private _logger = createLogger("message-gateway");
  private _channels: Map<string, MessageChannel> = new Map();
  private _db: DrizzleDB;

  constructor(db: DrizzleDB) {
    super();
    this._db = db;
  }

  /**
   * Register a message channel with the gateway.
   * Subscribes to the channel's `message:inbound` event and re-emits it.
   * @param channel - The message channel to register.
   */
  registerChannel(channel: MessageChannel): void {
    if (this._channels.has(channel.id)) {
      throw new Error(`Channel id "${channel.id}" is already registered.`);
    }
    this._channels.set(channel.id, channel);
    channel.on("message:inbound", (message: UserMessage) => {
      this._handleInboundMessage(channel.id, message);
    });
    channel.on("message:recalled", (messageId: string, channelId: string) => {
      this.emit("message:recalled", messageId, channelId);
    });
    channel.on("card:action", (payload: CardActionPayload) => {
      this.emit("card:action", payload);
    });
    this._logger.info(`Registered channel: ${channel.id}`);
  }

  /**
   * Start the gateway and all registered channels.
   */
  async start(): Promise<void> {
    for (const [id, channel] of this._channels) {
      this._logger.info(`Starting channel: ${id}`);
      await channel.start();
    }
    this._logger.info("Message gateway started");
  }

  /**
   * Post a new assistant message without replying to an existing message.
   * Routes by the explicit `options.channelId` when provided, otherwise by the
   * session's persisted `channel_id`.
   * @param message - The assistant message to post (without id).
   * @param options - Optional settings.
   * @returns The posted message with id assigned.
   */
  async postMessage(
    message: Omit<AssistantMessage, "id">,
    options?: { channelId?: string },
  ): Promise<AssistantMessage> {
    const channel = this._resolveChannelFor(message.session_id, options?.channelId);
    const result = await channel.postMessage(message);
    return result;
  }

  /**
   * Reply to an existing message.
   * Routes by the explicit `options.channelId` when provided, otherwise by the
   * session's persisted `channel_id`. Pass `channelId` for gateway-level replies
   * that fire before any Session is created.
   * @param messageId - ID of the message to reply to.
   * @param message - The assistant message to send (without id).
   * @param options - Optional settings.
   * @returns The sent message with id assigned.
   */
  async replyMessage(
    messageId: string,
    message: Omit<AssistantMessage, "id">,
    options?: { streaming?: boolean; channelId?: string },
  ): Promise<AssistantMessage> {
    const channel = this._resolveChannelFor(message.session_id, options?.channelId);
    const result = await channel.replyMessage(messageId, message, options);
    return result;
  }

  /**
   * Update the content of an existing message.
   * Routes by the explicit `options.channelId` when provided, otherwise by the
   * session's persisted `channel_id`.
   * @param message - The assistant message with updated content.
   * @param options - Optional settings.
   */
  async updateMessageContent(
    message: AssistantMessage,
    options?: { streaming?: boolean; channelId?: string },
  ): Promise<void> {
    const channel = this._resolveChannelFor(message.session_id, options?.channelId);
    await channel.updateMessageContent(message, options);
  }

  /**
   * Handles an inbound message from a channel: sets the channel_id on the
   * message and re-emits `message:inbound`.
   */
  private _handleInboundMessage(
    channelId: string,
    message: UserMessage,
  ): void {
    message.channel_id = channelId;
    this.emit("message:inbound", message);
  }

  /**
   * Resolves the target channel. If `explicitChannelId` is provided, it wins
   * (used for gateway-level replies before any Session is persisted). Otherwise
   * falls back to querying `channel_id` from the sessions table.
   * @throws If neither path yields a registered channel.
   */
  private _resolveChannelFor(
    sessionId: string,
    explicitChannelId?: string,
  ): MessageChannel {
    if (explicitChannelId) {
      return this._resolveChannel(explicitChannelId);
    }
    const row = this._db
      .select({ channel_id: sessions.channel_id })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .get();

    const channelId = row?.channel_id;
    if (!channelId) {
      throw new Error(
        `Cannot resolve channel for session "${sessionId}": no channel_id set.`,
      );
    }

    return this._resolveChannel(channelId);
  }

  /**
   * Looks up a registered channel by id.
   * @param channelId - The channel identifier.
   * @returns The matching MessageChannel.
   * @throws If the channel is not registered.
   */
  private _resolveChannel(channelId: string): MessageChannel {
    const channel = this._channels.get(channelId);
    if (!channel) {
      throw new Error(`Channel "${channelId}" is not registered.`);
    }
    return channel;
  }
}
