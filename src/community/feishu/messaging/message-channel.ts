import fs from "node:fs";
import nodePath from "node:path";

import { Client, EventDispatcher, WSClient } from "@larksuiteoapi/node-sdk";
import { eq } from "drizzle-orm";
import EventEmitter from "eventemitter3";

import type { DrizzleDB } from "@/data";
import type { Logger, TextMessageContent } from "@/shared";
import {
  config,
  createLogger,
  uuid,
  type AssistantMessage,
  type CardActionPayload,
  type MessageChannel,
  type MessageChannelEventTypes,
  type UserMessage,
} from "@/shared";


import { feishuBotGroups, feishuThreads } from "./data";
import {
  renderMessageCard,
  splitMarkdownByTables,
  splitMessageContentForCards,
} from "./message-renderer";
import type { Card, MessageReceiveEventData } from "./types";
import { convertPostToMarkdown } from "./utils";

/**
 * A chain of Feishu cards that together render a single logical assistant
 * message. The channel splits overflow-prone content (many tool steps,
 * table-heavy markdown) into multiple cards pre-flight rather than
 * retrying after Feishu rejects the PATCH.
 *
 * Invariants:
 *  - `cards[0]` is the anchor message_id, exposed to callers as
 *    `AssistantMessage.id`.
 *  - `cards[0..finalized-1]` are frozen: fully rendered in non-streaming
 *    form; we never PATCH them again.
 *  - `cards[cards.length - 1]` (when `finalized < cards.length`) is the
 *    active card receiving live updates.
 */
interface CardChain {
  cards: string[];
  finalized: number;
  replyInThread: boolean;
}

function _isFeishuBadRequestError(err: unknown): boolean {
  if (!err || typeof err !== "object") {
    return false;
  }

  const candidate = err as {
    status?: number;
    code?: number | string;
    response?: {
      status?: number;
      data?: {
        code?: number | string;
      };
    };
  };

  return (
    candidate.status === 400 ||
    candidate.code === 400 ||
    candidate.response?.status === 400 ||
    candidate.response?.data?.code === 400
  );
}

/** Message channel implementation for Feishu (Lark) chat platform. */
export class FeishuMessageChannel
  extends EventEmitter<MessageChannelEventTypes>
  implements MessageChannel
{
  readonly type = "feishu";

  private _inboundClient: WSClient;
  private _client: Client;
  private _db: DrizzleDB;
  private _failedCardUpdateMessages = new Set<string>();
  private _cardChains = new Map<string, CardChain>();
  private _logger: Logger;
  private _requireMention: boolean;
  private _botOpenId?: string;

  /**
   * Bot's own open_id as resolved at `start()`. `undefined` until the channel
   * has started, and when `require_mention` is disabled the bot-info fetch
   * is skipped so this stays undefined even post-start.
   */
  get botOpenId(): string | undefined {
    return this._botOpenId;
  }
  private _allowedUserOpenIds?: Set<string>;
  private _allowedUserEmails?: string[];

  /**
   * Create a Feishu message channel.
   * @param config - Feishu app credentials, plus optional inbound filters:
   *   - `requireMention`: when true, group-chat messages must @mention the bot.
   *     The bot's own open_id is resolved at `start()` via `/bot/v3/info`. P2P
   *     messages bypass the check — they are obviously directed at the bot.
   *   - `allowedUserOpenIds` / `allowedUserEmails`: when either is non-empty,
   *     the sender's open_id must be in the union of the two sets. Emails are
   *     resolved to open_ids at `start()` via `/contact/v3/users/batch_get_id`.
   * @param db - Drizzle database instance for persisting thread-to-session mappings.
   */
  constructor(
    readonly id: string,
    readonly config: {
      chatId: string;
      appId: string;
      appSecret: string;
      requireMention?: boolean;
      allowedUserOpenIds?: string[];
      allowedUserEmails?: string[];
    },
    db: DrizzleDB,
  ) {
    super();
    this.id = id;
    if (!config.appId || !config.appSecret) {
      throw new Error("Feishu app ID and secret are required");
    }
    this._db = db;
    this._logger = createLogger("feishu-message-channel");
    this._requireMention = !!config.requireMention;
    if (config.allowedUserOpenIds && config.allowedUserOpenIds.length > 0) {
      this._allowedUserOpenIds = new Set(config.allowedUserOpenIds);
    }
    if (config.allowedUserEmails && config.allowedUserEmails.length > 0) {
      this._allowedUserEmails = config.allowedUserEmails;
    }
    this._inboundClient = new WSClient({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
    });
    this._client = new Client({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
    });
  }

  /** Start listening for inbound messages via WebSocket. */
  async start() {
    const needsToken = this._requireMention || !!this._allowedUserEmails;
    const tenantToken = needsToken ? await this._fetchTenantAccessToken() : null;

    if (this._requireMention && tenantToken) {
      this._botOpenId = await this._fetchBotOpenId(tenantToken);
      this._logger.info(
        { bot_open_id: this._botOpenId },
        "resolved bot open_id for @mention filtering",
      );
    }

    if (this._allowedUserEmails && tenantToken) {
      const resolved = await this._resolveEmailsToOpenIds(
        this._allowedUserEmails,
        tenantToken,
      );
      if (!this._allowedUserOpenIds) {
        this._allowedUserOpenIds = new Set();
      }
      for (const openId of resolved.values()) {
        this._allowedUserOpenIds.add(openId);
      }
      const unresolved = this._allowedUserEmails.filter(
        (e) => !resolved.has(e),
      );
      this._logger.info(
        {
          resolved_count: resolved.size,
          unresolved,
          total_whitelist: this._allowedUserOpenIds.size,
        },
        "resolved email whitelist to open_ids",
      );
      if (unresolved.length > 0) {
        this._logger.warn(
          { unresolved },
          "some whitelisted emails could not be resolved to an open_id",
        );
      }
    }

    // The node-sdk's `IHandles` type doesn't include card-action events, but
    // the underlying `EventDispatcher.invoke` dispatches by event-type string,
    // and the WS gateway delivers `card.action.trigger` alongside regular
    // events for self-built Feishu apps. We cast through `as never` to bypass
    // the typing gap without loosening the strict lookup of typed handlers.
    await this._inboundClient.start({
      eventDispatcher: new EventDispatcher({}).register({
        "im.message.receive_v1": this._handleMessageReceive,
        "im.message.recalled_v1": this._handleMessageRecall,
        ["card.action.trigger" as never]: this
          ._handleCardAction as never,
      }),
    });
  }

  /**
   * Send a raw Feishu interactive card to a chat. Escape hatch used by
   * commands that render custom cards (e.g. `/setup`) outside the normal
   * AssistantMessage pipeline. Returns the posted message's id so the caller
   * can correlate later card actions / updates.
   *
   * `options.replyInThread` defaults to `false`: command-originated cards
   * should appear inline in the chat rather than opening a new topic. Pass
   * `true` explicitly if the flow is session-scoped.
   */
  async sendRawCard(
    chatId: string,
    card: Card,
    options: { replyTo?: string; replyInThread?: boolean } = {},
  ): Promise<string> {
    if (options.replyTo) {
      const { data } = await this._client.im.message.reply({
        path: { message_id: options.replyTo },
        data: {
          msg_type: "interactive",
          content: JSON.stringify(card),
          reply_in_thread: options.replyInThread ?? false,
        },
      });
      if (!data?.message_id) {
        throw new Error("Failed to reply with interactive card");
      }
      return data.message_id;
    }
    const { data } = await this._client.im.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: chatId,
        msg_type: "interactive",
        content: JSON.stringify(card),
      },
    });
    if (!data?.message_id) {
      throw new Error("Failed to post interactive card");
    }
    return data.message_id;
  }

  /**
   * Best-effort fetch of a chat's display name. The bot must be a member of
   * the chat, with `im:chat` or `im:chat:readonly` scope. Returns undefined
   * on any failure (permission denied, chat not found, network error) so
   * callers can fall back to a deterministic default.
   */
  async getChatName(chatId: string): Promise<string | undefined> {
    try {
      const { data } = await this._client.im.chat.get({
        path: { chat_id: chatId },
      });
      const name =
        data?.i18n_names?.zh_cn ?? data?.name ?? data?.i18n_names?.en_us;
      return typeof name === "string" && name.trim() ? name.trim() : undefined;
    } catch (err) {
      this._logger.warn({ err, chat_id: chatId }, "getChatName failed");
      return undefined;
    }
  }

  /**
   * Replace the content of an existing interactive card message. Used by
   * card-driven flows to transition the same message from "pending" to
   * "completed" without spawning a new reply.
   */
  async updateRawCard(messageId: string, card: Card): Promise<void> {
    await this._client.im.message.patch({
      path: { message_id: messageId },
      data: { content: JSON.stringify(card) },
    });
  }

  /**
   * Post a plain-text message into an arbitrary chat. Returns the posted
   * message's id so callers can anchor follow-up replies (e.g. `/group`
   * sends a welcome line then anchors its `/setup` card as a reply to it).
   *
   * Distinct from `postMessage(AssistantMessage)` which renders a card to
   * this channel's default `config.chatId`.
   */
  async sendPlainText(chatId: string, text: string): Promise<string> {
    const { data } = await this._client.im.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: chatId,
        msg_type: "text",
        content: JSON.stringify({ text }),
      },
    });
    if (!data?.message_id) {
      throw new Error("Failed to post plain text message");
    }
    return data.message_id;
  }

  /**
   * Create a new group chat. The bot itself ends up as the initial owner;
   * callers that want a human owner should follow up with
   * {@link transferChatOwner}. `memberOpenIds` are added at creation time so
   * no separate add-members round-trip is needed.
   *
   * Requires the `im:chat:create` scope.
   */
  async createChat(options: {
    name: string;
    memberOpenIds: string[];
    description?: string;
  }): Promise<string> {
    const { data } = await this._client.im.chat.create({
      params: { user_id_type: "open_id" },
      data: {
        name: options.name,
        description: options.description,
        chat_type: "private",
        user_id_list: options.memberOpenIds,
      },
    });
    if (!data?.chat_id) {
      throw new Error("Feishu returned no chat_id when creating the chat");
    }
    return data.chat_id;
  }

  /**
   * Transfer a group's owner to the specified user. The bot must currently
   * be the owner. Requires the `im:chat.owner:update` scope.
   */
  async transferChatOwner(
    chatId: string,
    ownerOpenId: string,
  ): Promise<void> {
    await this._client.im.chat.update({
      path: { chat_id: chatId },
      params: { user_id_type: "open_id" },
      data: { owner_id: ownerOpenId },
    });
  }

  /**
   * Dissolve a chat. Requires the bot to be the owner. Used by `/ungroup`
   * to tear down groups the bot created earlier.
   */
  async dismissChat(chatId: string): Promise<void> {
    await this._client.im.chat.delete({
      path: { chat_id: chatId },
    });
  }

  /**
   * Look up a bot-created group by its chat_id. Returns undefined when the
   * chat was not created by this bot (e.g. an existing group the bot was
   * just added to).
   */
  findBotGroup(chatId: string):
    | { chat_id: string; chat_name: string; creator_open_id: string }
    | undefined {
    const row = this._db
      .select({
        chat_id: feishuBotGroups.chat_id,
        chat_name: feishuBotGroups.chat_name,
        creator_open_id: feishuBotGroups.creator_open_id,
      })
      .from(feishuBotGroups)
      .where(eq(feishuBotGroups.chat_id, chatId))
      .get();
    return row ?? undefined;
  }

  /**
   * Find a bot-created group by either its display name or chat_id, scoped
   * to a single creator. Used by `/ungroup <query>` from P2P so users can
   * only dismiss groups they themselves created. Name match is exact
   * (multiple groups may share a name; the caller must disambiguate).
   */
  findBotGroupForCreator(
    query: string,
    creatorOpenId: string,
  ): Array<{ chat_id: string; chat_name: string }> {
    return this._db
      .select({
        chat_id: feishuBotGroups.chat_id,
        chat_name: feishuBotGroups.chat_name,
      })
      .from(feishuBotGroups)
      .where(eq(feishuBotGroups.creator_open_id, creatorOpenId))
      .all()
      .filter((row) => row.chat_id === query || row.chat_name === query);
  }

  /** Remove a bot-group record. Call after a successful `dismissChat`. */
  deleteBotGroupRecord(chatId: string): void {
    this._db
      .delete(feishuBotGroups)
      .where(eq(feishuBotGroups.chat_id, chatId))
      .run();
  }

  /**
   * Add one or more users to the runtime whitelist and persist the change to
   * `config.yaml`. Returns the open_ids that were actually new (not already
   * in the set) so callers can report a precise count back to the user.
   *
   * Mutates the channel's in-memory set immediately — new entries take effect
   * on the very next inbound message without a restart. Persistence keeps
   * the change across restarts; we re-use Bun's YAML parser/stringifier so
   * the file stays round-trippable.
   */
  async addToWhitelist(openIds: string[]): Promise<string[]> {
    if (!this._allowedUserOpenIds) {
      // The whitelist was disabled (empty set accepts everyone). Initialize
      // a fresh one — the newly-added users become the whole allow-list.
      this._allowedUserOpenIds = new Set<string>();
    }
    const added: string[] = [];
    for (const openId of openIds) {
      if (!this._allowedUserOpenIds.has(openId)) {
        this._allowedUserOpenIds.add(openId);
        added.push(openId);
      }
    }
    if (added.length === 0) return added;
    try {
      await this._persistWhitelistToConfig();
    } catch (err) {
      this._logger.error(
        { err, channel_id: this.id, added },
        "failed to persist whitelist addition; in-memory set was still updated",
      );
      throw err;
    }
    return added;
  }

  private async _persistWhitelistToConfig(): Promise<void> {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const { config: cfgModule } = await import("@/shared");
    const configPath = path.join(cfgModule.paths.home, "config.yaml");
    const raw = await fs.readFile(configPath, "utf-8");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Bun.YAML types are not in @types yet
    const parsed = (Bun as any).YAML.parse(raw) as {
      messaging?: {
        channels?: Array<{
          id: string;
          params?: Record<string, unknown>;
        }>;
      };
    };
    const channel = parsed.messaging?.channels?.find((c) => c.id === this.id);
    if (!channel) {
      throw new Error(
        `channel \`${this.id}\` not found in config.yaml — whitelist write aborted`,
      );
    }
    if (!channel.params) channel.params = {};
    channel.params.allowed_user_ids = Array.from(
      this._allowedUserOpenIds ?? [],
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Bun.YAML types are not in @types yet
    const serialized = (Bun as any).YAML.stringify(parsed);
    await fs.writeFile(configPath, serialized, "utf-8");
  }

  /**
   * Exchange app credentials for a tenant access token. Used for REST calls
   * that the node-sdk doesn't expose directly (bot info, email→id lookup).
   */
  private async _fetchTenantAccessToken(): Promise<string> {
    const res = await fetch(
      "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
      {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({
          app_id: this.config.appId,
          app_secret: this.config.appSecret,
        }),
      },
    );
    const json = (await res.json()) as {
      code: number;
      msg: string;
      tenant_access_token?: string;
    };
    if (json.code !== 0 || !json.tenant_access_token) {
      throw new Error(
        `Failed to obtain tenant_access_token: ${json.code} ${json.msg}`,
      );
    }
    return json.tenant_access_token;
  }

  /**
   * Fetch the bot's own open_id via `/bot/v3/info`. Requires the bot app to
   * have "Get bot info" permission. Throws on failure — we'd rather fail loud
   * than silently accept every message when the user asked for mention-only.
   */
  private async _fetchBotOpenId(tenantToken: string): Promise<string> {
    const res = await fetch("https://open.feishu.cn/open-apis/bot/v3/info", {
      method: "GET",
      headers: { Authorization: `Bearer ${tenantToken}` },
    });
    const json = (await res.json()) as {
      code: number;
      msg: string;
      bot?: { open_id?: string };
    };
    if (json.code !== 0 || !json.bot?.open_id) {
      throw new Error(`Failed to fetch bot info: ${json.code} ${json.msg}`);
    }
    return json.bot.open_id;
  }

  /**
   * Resolve emails to open_ids via `/contact/v3/users/batch_get_id`. Requires
   * the bot app to have "Get user ID by mobile/email" permission. Emails that
   * don't map to a user are omitted from the returned map (the caller logs
   * unresolved entries). Batches of 50 per the API limit.
   */
  private async _resolveEmailsToOpenIds(
    emails: string[],
    tenantToken: string,
  ): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    for (let i = 0; i < emails.length; i += 50) {
      const batch = emails.slice(i, i + 50);
      const res = await fetch(
        "https://open.feishu.cn/open-apis/contact/v3/users/batch_get_id?user_id_type=open_id",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${tenantToken}`,
            "Content-Type": "application/json; charset=utf-8",
          },
          body: JSON.stringify({ emails: batch, mobiles: [] }),
        },
      );
      const json = (await res.json()) as {
        code: number;
        msg: string;
        data?: {
          user_list?: Array<{ email?: string; user_id?: string }>;
        };
      };
      if (json.code !== 0) {
        throw new Error(
          `Failed to resolve emails (${batch.length}): ${json.code} ${json.msg}`,
        );
      }
      for (const entry of json.data?.user_list ?? []) {
        if (entry.email && entry.user_id) {
          result.set(entry.email, entry.user_id);
        }
      }
    }
    return result;
  }

  /**
   * Reply to a message. Defaults to opening a new Feishu topic
   * (`reply_in_thread: true`) because most replies are session-scoped
   * assistant output. Pass `replyInThread: false` for one-shot replies (slash
   * commands, quick error messages) that should render inline instead.
   *
   * When `replyInThread` is false, the thread→session mapping is skipped —
   * there's no new thread to map, and the reply doesn't belong to any
   * session anyway.
   */
  async replyMessage(
    messageId: string,
    message: Omit<AssistantMessage, "id">,
    {
      streaming = true,
      replyInThread = true,
    }: { streaming?: boolean; replyInThread?: boolean } = {},
  ): Promise<AssistantMessage> {
    const chunks = this._splitIntoCardChunks(message.content, streaming);
    if (!streaming) {
      this._logOutboundMessage(message.session_id, message.content);
    }

    // Post the primary (first chunk) as a reply to the user's message.
    const primaryCard = await this._renderChunk(chunks[0]!, {
      streaming: streaming && chunks.length === 1,
    });
    const { data: replyMessage } = await this._client.im.message.reply({
      path: { message_id: messageId },
      data: {
        msg_type: "interactive",
        content: JSON.stringify(primaryCard),
        reply_in_thread: replyInThread,
      },
    });
    if (!replyMessage?.message_id) {
      throw new Error("Failed to reply message");
    }
    const anchorId = replyMessage.message_id;

    if (replyInThread && replyMessage.thread_id) {
      this._mapThreadToSession(replyMessage.thread_id, message.session_id);
    }

    const chain: CardChain = {
      cards: [anchorId],
      finalized: 0,
      replyInThread,
    };
    await this._growChainToFit(chain, chunks, streaming);
    if (!streaming) {
      chain.finalized = chain.cards.length;
    }
    this._cardChains.set(anchorId, chain);

    const assistantMessage = message as AssistantMessage;
    assistantMessage.id = anchorId;

    if (!streaming) {
      await this._sendFileAttachmentsForFinalText(
        assistantMessage.id,
        message.content,
      );
    }
    return assistantMessage;
  }

  async postMessage(
    message: Omit<AssistantMessage, "id">,
  ): Promise<AssistantMessage> {
    const chunks = this._splitIntoCardChunks(message.content, false);
    this._logOutboundMessage(message.session_id, message.content);

    const primaryCard = await this._renderChunk(chunks[0]!, {
      streaming: false,
    });
    const { data } = await this._client.im.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: this.config.chatId,
        msg_type: "interactive",
        content: JSON.stringify(primaryCard),
      },
    });
    if (!data?.message_id) {
      throw new Error("Failed to post message");
    }
    const anchorId = data.message_id;

    const chain: CardChain = {
      cards: [anchorId],
      finalized: 0,
      // post-then-reply continuation cards attach to the primary with
      // reply_in_thread:true, matching the pre-chain behavior.
      replyInThread: true,
    };
    await this._growChainToFit(chain, chunks, /* streaming */ false);
    // postMessage is always a final one-shot — lock the whole chain so the
    // primary (created outside _growChainToFit) is counted as finalized too.
    chain.finalized = chain.cards.length;
    this._cardChains.set(anchorId, chain);

    const assistantMessage = message as AssistantMessage;
    assistantMessage.id = anchorId;

    await this._sendFileAttachmentsForFinalText(
      assistantMessage.id,
      message.content,
    );

    const emojis = [
      "思考中",
      "送你小红花",
      "送心",
      "灵光一现",
      "辛勤营业",
      "挥手",
    ];
    const { data: replyData } = await this._client.im.message.reply({
      path: { message_id: assistantMessage.id },
      data: {
        content: JSON.stringify({
          type: "text",
          text: `[${emojis[Math.floor(Math.random() * emojis.length)]}] Reply here to continue the conversation`,
        }),
        msg_type: "text",
        reply_in_thread: true,
      },
    });
    if (replyData?.thread_id) {
      this._mapThreadToSession(replyData.thread_id, message.session_id);
    }
    return assistantMessage;
  }

  /** Update the content of an existing Feishu message. */
  async updateMessageContent(
    message: AssistantMessage,
    { streaming = true }: { streaming?: boolean } = {},
  ): Promise<void> {
    if (this._failedCardUpdateMessages.has(message.id)) {
      return;
    }

    const chain =
      this._cardChains.get(message.id) ??
      // Lazy-init: a channel restart can lose in-memory chain state. Treat
      // the incoming `message.id` as the anchor of a fresh single-card chain
      // and let `_growChainToFit` append continuations as needed.
      ({
        cards: [message.id],
        finalized: 0,
        replyInThread: true,
      } as CardChain);

    const chunks = this._splitIntoCardChunks(message.content, streaming);
    if (!streaming) {
      this._logOutboundMessage(message.session_id, message.content);
    }

    try {
      // Freeze any previously-active cards that are no longer the last in
      // the chain (new step cards have been added after them).
      while (chain.finalized < Math.min(chunks.length - 1, chain.cards.length)) {
        const idx = chain.finalized;
        const frozenCard = await this._renderChunk(chunks[idx]!, {
          streaming: false,
        });
        await this._patchCard(chain.cards[idx]!, frozenCard);
        chain.finalized++;
      }

      const initialLen = chain.cards.length;
      await this._growChainToFit(chain, chunks, streaming);

      // If we didn't grow the chain this round, the active (last) card
      // still needs a refresh to pick up the new steps. Skip when the last
      // card is already frozen, or when the chunk it was rendered from no
      // longer exists (defensive — content isn't expected to shrink).
      const lastIdx = chain.cards.length - 1;
      if (
        chain.cards.length === initialLen &&
        lastIdx >= 0 &&
        chain.finalized <= lastIdx &&
        lastIdx < chunks.length
      ) {
        const card = await this._renderChunk(chunks[lastIdx]!, { streaming });
        await this._patchCard(chain.cards[lastIdx]!, card);
      }
      // Final state reached — lock the whole chain so any stray later calls
      // are no-ops rather than redundant PATCHes.
      if (!streaming) {
        chain.finalized = chain.cards.length;
      }

      this._cardChains.set(message.id, chain);
    } catch (err) {
      if (_isFeishuBadRequestError(err)) {
        this._failedCardUpdateMessages.add(message.id);
        this._logger.warn(
          { err, message_id: message.id, session_id: message.session_id },
          "Feishu card update failed with 400; sending fallback reply",
        );
        await this._replyUpdateFailureMessage(message.id);
        return;
      }
      throw err;
    }

    if (!streaming) {
      await this._sendFileAttachmentsForFinalText(message.id, message.content);
    }
  }

  /**
   * Uploads an image to Feishu. Returns the key of the uploaded image.
   * @param path - The path to the image to upload.
   * @returns The key of the uploaded image.
   */
  async uploadImage(path: string): Promise<string> {
    const absPath = nodePath.join(config.paths.home, path);
    const file = fs.readFileSync(absPath);
    this._logger.info(`Uploading image ${absPath}`);
    const res = await this._client.im.v1.image.create({
      data: {
        image_type: "message",
        image: file,
      },
    });
    this._logger.info(
      `Uploaded image ${absPath} -> ${res?.image_key || "failed"}`,
    );
    if (res?.image_key) {
      return res.image_key;
    } else {
      throw new Error("Failed to upload image");
    }
  }

  /**
   * Uploads a file to Feishu. Returns the key of the uploaded file.
   * @param filePath - The path to the file relative to the home directory.
   * @returns The key of the uploaded file.
   */
  async uploadFile(filePath: string): Promise<string> {
    const absPath = nodePath.join(config.paths.home, filePath);
    const file = fs.createReadStream(absPath);
    const fileName = nodePath.basename(absPath);
    const ext = nodePath.extname(absPath).slice(1).toLowerCase();
    const fileTypeMap: Record<
      string,
      "opus" | "mp4" | "pdf" | "doc" | "xls" | "ppt" | "stream"
    > = {
      opus: "opus",
      mp4: "mp4",
      pdf: "pdf",
      doc: "doc",
      docx: "doc",
      xls: "xls",
      xlsx: "xls",
      ppt: "ppt",
      pptx: "ppt",
    };
    const fileType = fileTypeMap[ext] ?? "stream";
    this._logger.info(`Uploading file ${absPath} (type: ${fileType})`);
    const res = await this._client.im.v1.file.create({
      data: {
        file_type: fileType,
        file_name: fileName,
        file,
      },
    });
    this._logger.info(
      `Uploaded file ${absPath} -> ${res?.file_key || "failed"}`,
    );
    if (res?.file_key) {
      return res.file_key;
    } else {
      throw new Error("Failed to upload file");
    }
  }

  /**
   * Downloads an image or a file from a message.
   * @param messageId - The ID of the message to download the resource from.
   * @param file_key - The key of the file to download.
   * @param file_name - The name of the file to download. If not provided, the file name will be inferred from the file key.
   * @returns The path to the downloaded file.
   */
  async downloadMessageResource(
    messageId: string,
    file_key: string,
    file_name?: string,
  ): Promise<string> {
    const { writeFile, headers } = await this._client.im.v1.messageResource.get(
      {
        path: {
          message_id: messageId,
          file_key,
        },
        params: {
          type: "file",
        },
      },
    );
    const metadata = JSON.parse(
      headers.get("inner_file_data_meta") as string,
    ) as {
      FileName: string;
      Mime: string;
    };
    const isImage = metadata.Mime.startsWith("image/");
    let dir = config.paths.uploads;
    if (isImage) {
      dir = nodePath.join(dir, "images");
    }
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    let filename: string;
    if (file_name) {
      filename = file_name;
    } else {
      filename = metadata.FileName === "image" ? file_key : metadata.FileName;
      if (metadata.Mime.startsWith("image/")) {
        filename += "." + metadata.Mime.split("/")[1];
      } else if (metadata.Mime === "audio/octet-stream") {
        filename += ".ogg";
      } else {
        filename += `.${metadata.Mime.split("/")[1]}`;
      }
    }
    const extname = nodePath.extname(filename);
    filename = filename.substring(0, filename.length - extname.length);
    if (fs.existsSync(nodePath.join(dir, filename + extname))) {
      let i = 1;
      while (fs.existsSync(nodePath.join(dir, filename + `-${i}` + extname))) {
        i++;
      }
      filename += `-${i}`;
    }
    filename += extname;
    await writeFile(nodePath.join(dir, filename));
    return nodePath.relative(config.paths.home, nodePath.join(dir, filename));
  }

  /**
   * Split assistant message content into a list of card-ready chunks.
   *
   * Stage 1 — step panel overflow: spread thinking/tool_use blocks across
   * chunks capped at {@link MAX_STEPS_PER_CARD} so no single panel exceeds
   * Feishu's 50-element container cap.
   *
   * Stage 2 — markdown table overflow (non-streaming only): the final
   * answer lives on the last step chunk; if it carries more than Feishu's
   * 5-tables-per-card limit, the surplus gets peeled off into text-only
   * continuation chunks appended after the last step chunk.
   *
   * During streaming we skip stage 2 because the final text isn't present
   * yet (and any interim text is ephemeral).
   */
  private _splitIntoCardChunks(
    content: AssistantMessage["content"],
    streaming: boolean,
  ): AssistantMessage["content"][] {
    const chunks = splitMessageContentForCards(content);
    if (streaming) {
      return chunks;
    }
    const last = chunks[chunks.length - 1]!;
    const lastTextIdx = last.findLastIndex((c) => c.type === "text");
    if (lastTextIdx === -1) return chunks;
    const lastText = last[lastTextIdx]!;
    if (lastText.type !== "text") return chunks;
    const textChunks = splitMarkdownByTables(lastText.text);
    if (textChunks.length <= 1) return chunks;
    const rewrittenLast = [...last];
    rewrittenLast[lastTextIdx] = { ...lastText, text: textChunks[0]! };
    chunks[chunks.length - 1] = rewrittenLast as AssistantMessage["content"];
    for (let i = 1; i < textChunks.length; i++) {
      chunks.push([
        { type: "text", text: textChunks[i]! },
      ] as AssistantMessage["content"]);
    }
    return chunks;
  }

  /** Render a single card-chunk. */
  private async _renderChunk(
    chunk: AssistantMessage["content"],
    { streaming }: { streaming: boolean },
  ): Promise<Card> {
    return renderMessageCard(chunk, {
      streaming,
      uploadImage: this.uploadImage.bind(this),
    });
  }

  /** PATCH an existing Feishu card with a new body. */
  private async _patchCard(messageId: string, card: Card): Promise<void> {
    await this._client.im.message.patch({
      path: { message_id: messageId },
      data: { content: JSON.stringify(card) },
    });
  }

  /**
   * Extend {@link chain} so it has a Feishu card for every chunk in
   * {@link chunks}. Newly created non-last chunks are posted in frozen
   * form and immediately marked finalized — we won't touch them again.
   * The trailing chunk is posted in its current streaming state so it
   * keeps receiving live updates.
   */
  private async _growChainToFit(
    chain: CardChain,
    chunks: AssistantMessage["content"][],
    streaming: boolean,
  ): Promise<void> {
    while (chain.cards.length < chunks.length) {
      const idx = chain.cards.length;
      const isLast = idx === chunks.length - 1;
      const card = await this._renderChunk(chunks[idx]!, {
        streaming: streaming && isLast,
      });
      // Continuation cards hang off the anchor so Feishu renders them as
      // siblings within the same topic thread. Replying to the previous
      // continuation would nest them infinitely.
      const { data } = await this._client.im.message.reply({
        path: { message_id: chain.cards[0]! },
        data: {
          msg_type: "interactive",
          content: JSON.stringify(card),
          reply_in_thread: chain.replyInThread,
        },
      });
      if (!data?.message_id) {
        throw new Error("Failed to post continuation card");
      }
      chain.cards.push(data.message_id);
      // Finalize non-last cards unconditionally, and the trailing card too
      // when the whole message is non-streaming (no more updates coming).
      if (!isLast || !streaming) {
        chain.finalized++;
      }
    }
  }

  /** Send file attachments referenced in the final text block, if any. */
  private async _sendFileAttachmentsForFinalText(
    messageId: string,
    content: AssistantMessage["content"],
  ): Promise<void> {
    const lastText = content.filter((c) => c.type === "text").pop();
    if (lastText?.type === "text") {
      await this._sendLocalFileAttachments(messageId, lastText.text);
    }
  }

  /** Extract local file paths from markdown link syntax [text](path) in text. */
  private _extractLocalFilePaths(text: string): string[] {
    const linkRegex = /(?<!!)\[.*?\]\(([^)]+)\)/g;
    const paths: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = linkRegex.exec(text)) !== null) {
      const filePath = match[1];
      if (
        filePath &&
        !filePath.includes("://") &&
        fs.existsSync(nodePath.join(config.paths.home, filePath))
      ) {
        paths.push(filePath);
      }
    }
    return paths;
  }

  /** Upload local files referenced in text and send them as Feishu file message replies. */
  private async _sendLocalFileAttachments(
    messageId: string,
    text: string,
  ): Promise<void> {
    const filePaths = this._extractLocalFilePaths(text);
    const seen = new Set<string>();
    for (const filePath of filePaths) {
      if (seen.has(filePath)) continue;
      seen.add(filePath);
      try {
        const fileKey = await this.uploadFile(filePath);
        await this._client.im.message.reply({
          path: { message_id: messageId },
          data: {
            msg_type: "file",
            content: JSON.stringify({ file_key: fileKey }),
            reply_in_thread: true,
          },
        });
        this._logger.info(`Sent file ${filePath} as Feishu attachment`);
      } catch (err) {
        this._logger.warn(
          { err },
          `Failed to send file attachment: ${filePath}`,
        );
      }
    }
  }

  private async _replyUpdateFailureMessage(messageId: string): Promise<void> {
    try {
      await this._client.im.message.reply({
        path: {
          message_id: messageId,
        },
        data: {
          msg_type: "text",
          content: JSON.stringify({
            text: "抱歉，这条消息更新失败了，请稍后重试。",
          }),
          reply_in_thread: true,
        },
      });
    } catch (err) {
      this._logger.warn(
        { err, message_id: messageId },
        "Failed to send fallback reply after Feishu card update error",
      );
    }
  }

  private _logOutboundMessage(
    sessionId: string,
    content: AssistantMessage["content"],
  ) {
    const lastText = content.filter((item) => item.type === "text").pop();
    const finalText = lastText?.type === "text" ? lastText.text : null;
    this._logger.info([sessionId, finalText], "Final Feishu outbound content");
  }

  private _handleMessageReceive = async (
    eventData: MessageReceiveEventData,
  ) => {
    const { sender, message: receivedMessage } = eventData;
    const {
      message_id: messageId,
      thread_id: threadId,
      chat_id: chatId,
      chat_type: chatType,
      message_type: messageType,
      mentions,
    } = receivedMessage;
    const senderOpenId = sender?.sender_id?.open_id;

    const isAllowedSender =
      !this._allowedUserOpenIds ||
      (senderOpenId != null && this._allowedUserOpenIds.has(senderOpenId));

    // Slash commands (e.g. `/setup`, `/bind`) intentionally bypass the
    // @-mention requirement — operators should be able to run them with a
    // single keystroke in the chat bar. The sender whitelist still applies.
    const isSlashCommand = _peekSlashCommand(
      messageType,
      receivedMessage.content,
    );
    // Messages inside a thread the bot has already engaged in are implicitly
    // directed at the bot — no need to @-mention again. The `feishu_threads`
    // table tracks every thread the bot has participated in (either by
    // starting it via reply/post, or by being @-mentioned into it earlier).
    const isInBotThread = this._isInBotThread(threadId);
    const mentionEnforced =
      this._requireMention &&
      chatType === "group" &&
      !isSlashCommand &&
      !isInBotThread;
    const isBotMentioned =
      !!this._botOpenId &&
      !!mentions?.some((m) => m.id?.open_id === this._botOpenId);
    const mentionOk = !mentionEnforced || isBotMentioned;

    this._logger.info(
      {
        message_id: messageId,
        chat_id: chatId,
        chat_type: chatType,
        message_type: messageType,
        sender_open_id: senderOpenId,
        bot_mentioned: isBotMentioned,
        slash_command: isSlashCommand,
        in_bot_thread: isInBotThread,
        passed: isAllowedSender && mentionOk,
      },
      "inbound message",
    );

    if (!isAllowedSender) {
      this._logger.info(
        { message_id: messageId, sender_open_id: senderOpenId },
        "dropping inbound: sender not in whitelist",
      );
      return;
    }
    if (!mentionOk) {
      this._logger.info(
        { message_id: messageId, chat_id: chatId },
        "dropping inbound: bot not @mentioned in group chat",
      );
      return;
    }

    const session_id = this._resolveSessionId(chatId, threadId);
    // Normalize Feishu's chat_type into the shared enum so command handlers
    // can gate on group-vs-P2P without reaching back into provider details.
    // Feishu emits `"p2p"` (not `"single"`) for 1:1 chats — accept both to be
    // robust against SDK version drift.
    const normalizedChatType: "group" | "single" | undefined =
      chatType === "group"
        ? "group"
        : chatType === "p2p" || chatType === "single"
          ? "single"
          : undefined;
    // Propagate the raw Feishu mentions into a provider-agnostic list so
    // downstream command handlers (`/group`, `/allow`) can resolve the
    // `@_user_N` placeholders that appear in the text content.
    const normalizedMentions: Array<{
      key: string;
      open_id: string;
      name?: string;
    }> = [];
    for (const m of mentions ?? []) {
      const openId = m.id?.open_id;
      if (!openId || !m.key) continue;
      normalizedMentions.push({
        key: m.key,
        open_id: openId,
        name: m.name,
      });
    }
    const userMessage: UserMessage = {
      id: messageId,
      session_id,
      role: "user",
      channel_id: this.id,
      chat_id: chatId,
      chat_type: normalizedChatType,
      thread_id: threadId,
      sender_open_id: senderOpenId,
      mentions:
        normalizedMentions.length > 0 ? normalizedMentions : undefined,
      content: [
        await this._parseMessageContent(
          messageId,
          receivedMessage.message_type,
          receivedMessage.content,
        ),
      ],
    };
    this.emit("message:inbound", userMessage);
  };

  private _handleMessageRecall = async (data: {
    message_id?: string;
    chat_id?: string;
    recall_time?: string;
    recall_type?: string;
  }) => {
    if (!data.message_id) return;
    this._logger.info({ message_id: data.message_id }, "message recalled");
    this.emit("message:recalled", data.message_id, this.id);
  };

  /**
   * Handle a `card.action.trigger` event delivered via the WS event stream.
   * Normalizes the provider-specific shape into `CardActionPayload` and emits
   * `card:action`; the kernel dispatches by `action_name`.
   */
  private _handleCardAction = async (data: {
    operator?: { open_id?: string; tenant_key?: string };
    action?: {
      value?: Record<string, unknown>;
      form_value?: Record<string, unknown>;
      tag?: string;
      name?: string;
    };
    context?: { open_message_id?: string; open_chat_id?: string };
  }) => {
    const messageId = data.context?.open_message_id;
    const operatorOpenId = data.operator?.open_id;
    if (!messageId || !operatorOpenId) {
      this._logger.warn(
        { data },
        "ignoring card.action.trigger with missing message_id/operator",
      );
      return;
    }
    const value = data.action?.value ?? {};
    // `action.value.action` is set for callback buttons (`behaviors[].value`).
    // For form_submit buttons we don't attach behaviors, so fall back to the
    // submit button's `name`, which Feishu echoes at `action.name`. That makes
    // the submit-button name the de-facto action discriminator for forms.
    const actionName =
      typeof value.action === "string"
        ? value.action
        : typeof data.action?.name === "string"
          ? data.action.name
          : "";
    const payload: CardActionPayload = {
      message_id: messageId,
      channel_id: this.id,
      chat_id: data.context?.open_chat_id,
      operator_open_id: operatorOpenId,
      action_name: actionName,
      value,
      form_value: data.action?.form_value ?? {},
    };
    this._logger.info(
      {
        message_id: messageId,
        action_name: actionName,
        operator_open_id: operatorOpenId,
        form_value: data.action?.form_value,
        raw_value: value,
      },
      "card action",
    );
    this.emit("card:action", payload);
    // Acknowledge the action back to Feishu via the WS response (the SDK
    // base64-encodes this as respPayload.data). Without an ack, the card UI
    // can surface a generic failure toast while the real work happens
    // asynchronously. Handlers downstream update the card in-place via
    // `updateRawCard` when done.
    return {
      toast: { type: "info", content: "已收到，正在处理…" },
    };
  };

  private _threadIdToSessionId = new Map<string, string>();

  /**
   * Returns true if `threadId` belongs to a thread the bot has engaged in
   * before (either by starting it via reply/post, or by being @-mentioned
   * into it). Used to bypass the @-mention requirement for follow-up
   * messages inside a bot-owned topic. Cheap: in-memory cache first, then
   * indexed single-row lookup on `feishu_threads`.
   */
  private _isInBotThread(threadId: string | undefined): boolean {
    if (!threadId) return false;
    if (this._threadIdToSessionId.has(threadId)) return true;
    const row = this._db
      .select({ session_id: feishuThreads.session_id })
      .from(feishuThreads)
      .where(eq(feishuThreads.thread_id, threadId))
      .get();
    if (row) {
      this._threadIdToSessionId.set(threadId, row.session_id);
      return true;
    }
    return false;
  }

  /** Persist a thread→session mapping to DB and update the in-memory cache. */
  private _mapThreadToSession(threadId: string, sessionId: string) {
    this._threadIdToSessionId.set(threadId, sessionId);
    this._db
      .insert(feishuThreads)
      .values({
        thread_id: threadId,
        session_id: sessionId,
        created_at: Date.now(),
      })
      .onConflictDoNothing()
      .run();
  }

  /**
   * Resolve session id for an inbound Feishu message.
   *
   * Lookup order:
   * 1. In-memory thread→session cache
   * 2. `feishu_threads` DB mapping (populated when the bot replies and Feishu
   *    creates a new thread — see `_mapThreadToSession`)
   * 3. When both chat_id + thread_id are known, derive deterministically as
   *    `feishu:<chat>:<thread>` and persist that mapping so subsequent lookups
   *    short-circuit.
   * 4. Fall back to `uuid()` when no thread_id (first @mention outside any
   *    topic).
   */
  private _resolveSessionId(
    chatId: string | undefined,
    threadId: string | undefined,
  ): string {
    if (threadId && this._threadIdToSessionId.has(threadId)) {
      return this._threadIdToSessionId.get(threadId)!;
    }
    if (threadId) {
      const row = this._db
        .select({ session_id: feishuThreads.session_id })
        .from(feishuThreads)
        .where(eq(feishuThreads.thread_id, threadId))
        .get();
      if (row) {
        this._threadIdToSessionId.set(threadId, row.session_id);
        return row.session_id;
      }
      if (chatId) {
        const derived = `feishu:${chatId}:${threadId}`;
        this._mapThreadToSession(threadId, derived);
        return derived;
      }
    }
    return uuid();
  }

  private async _parseMessageContent(
    messageId: string,
    type: string,
    content: string,
  ): Promise<TextMessageContent> {
    const json = JSON.parse(content);
    if (type === "text") {
      return {
        type: "text",
        text: json.text,
      };
    } else if (type === "post") {
      const markdown = await convertPostToMarkdown(
        json,
        this.downloadMessageResource.bind(this, messageId),
      );
      return {
        type: "text",
        text: markdown,
      };
    } else if (type === "image") {
      const file_key = json.image_key as string;
      const path = await this.downloadMessageResource(messageId, file_key);
      return {
        type: "text",
        text: `![user_uploaded_image](${path})`,
      };
    } else if (type === "file") {
      const file_key = json.file_key as string;
      const file_name = json.file_name as string;
      const path = await this.downloadMessageResource(
        messageId,
        file_key,
        file_name,
      );
      return {
        type: "text",
        text: `A new file message uploaded to \`${path}\``,
      };
    } else {
      this._logger.error(`Unsupported message type: ${type}`);
      return { type: "text", text: "Unsupported message type" + type };
    }
  }
}

/**
 * Cheap check for whether an inbound Feishu message looks like a slash
 * command, so we can skip the @-mention requirement for those. We only
 * inspect raw `text` content — post/image/file messages are never
 * considered slash commands. Parsing failures → treat as non-slash.
 */
function _peekSlashCommand(type: string, content: string): boolean {
  if (type !== "text") return false;
  try {
    const json = JSON.parse(content) as { text?: unknown };
    const text = typeof json.text === "string" ? json.text.trimStart() : "";
    return /^\/[a-zA-Z]/.test(text);
  } catch {
    return false;
  }
}
