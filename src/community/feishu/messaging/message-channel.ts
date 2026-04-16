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


import { feishuThreads } from "./data";
import { renderMessageCard, splitMarkdownByTables } from "./message-renderer";
import type { Card, MessageReceiveEventData } from "./types";
import { convertPostToMarkdown } from "./utils";

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
  private _logger: Logger;
  private _requireMention: boolean;
  private _botOpenId?: string;
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
    const { firstMessageContent, remainingChunks } = this._prepareMessageContent(
      message.content,
      streaming,
    );

    const card = await renderMessageCard(firstMessageContent, {
      streaming,
      uploadImage: this.uploadImage.bind(this),
    });
    if (!streaming) {
      this._logOutboundMessage(message.session_id, message.content);
    }
    const { data: replyMessage } = await this._client.im.message.reply({
      path: {
        message_id: messageId,
      },
      data: {
        msg_type: "interactive",
        content: JSON.stringify(card),
        reply_in_thread: replyInThread,
      },
    });
    if (!replyMessage) {
      throw new Error("Failed to reply message");
    }

    if (replyInThread) {
      const { thread_id: threadId } = replyMessage;
      if (threadId) {
        this._mapThreadToSession(threadId, message.session_id);
      }
    }

    await this._sendRemainingChunks(
      replyMessage.message_id!,
      remainingChunks,
      replyInThread,
    );

    const assistantMessage = message as AssistantMessage;
    assistantMessage.id = replyMessage.message_id!;

    if (!streaming) {
      const lastText = message.content.filter((c) => c.type === "text").pop();
      if (lastText?.type === "text") {
        await this._sendLocalFileAttachments(
          assistantMessage.id,
          lastText.text,
        );
      }
    }

    return assistantMessage;
  }

  async postMessage(
    message: Omit<AssistantMessage, "id">,
  ): Promise<AssistantMessage> {
    const { firstMessageContent, remainingChunks } = this._prepareMessageContent(
      message.content,
      false,
    );

    const card = await renderMessageCard(firstMessageContent, {
      streaming: false,
      uploadImage: this.uploadImage.bind(this),
    });
    this._logOutboundMessage(message.session_id, message.content);
    const { data } = await this._client.im.message.create({
      params: {
        receive_id_type: "chat_id",
      },
      data: {
        receive_id: this.config.chatId,
        msg_type: "interactive",
        content: JSON.stringify(card),
      },
    });
    if (!data) {
      throw new Error("Failed to post message");
    }
    const { message_id: messageId } = data;
    const assistantMessage = message as AssistantMessage;
    assistantMessage.id = messageId!;

    await this._sendRemainingChunks(assistantMessage.id, remainingChunks);

    const lastText = message.content.filter((c) => c.type === "text").pop();
    if (lastText?.type === "text") {
      await this._sendLocalFileAttachments(assistantMessage.id, lastText.text);
    }

    const emojis = [
      "思考中",
      "送你小红花",
      "送心",
      "灵光一现",
      "辛勤营业",
      "挥手",
    ];
    const { data: replyData } = await this._client.im.message.reply({
      path: {
        message_id: assistantMessage.id,
      },
      data: {
        content: JSON.stringify({
          type: "text",
          text: `[${emojis[Math.floor(Math.random() * emojis.length)]}] Reply here to continue the conversation`,
        }),
        msg_type: "text",
        reply_in_thread: true,
      },
    });
    if (replyData) {
      const { thread_id: threadId } = replyData;
      const sessionId = message.session_id;
      this._mapThreadToSession(threadId!, sessionId);
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

    const { firstMessageContent, remainingChunks } = this._prepareMessageContent(
      message.content,
      streaming,
    );

    const card = await renderMessageCard(firstMessageContent, {
      streaming,
      uploadImage: this.uploadImage.bind(this),
    });
    if (!streaming) {
      this._logOutboundMessage(message.session_id, message.content);
    }
    try {
      await this._client.im.message.patch({
        path: {
          message_id: message.id,
        },
        data: {
          content: JSON.stringify(card),
        },
      });
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

    await this._sendRemainingChunks(message.id, remainingChunks);

    if (!streaming) {
      const lastText = message.content.filter((c) => c.type === "text").pop();
      if (lastText?.type === "text") {
        await this._sendLocalFileAttachments(message.id, lastText.text);
      }
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
   * Prepare message content for sending, splitting if necessary due to table limits.
   * @param content - Original message content.
   * @param streaming - Whether the message is being streamed (skip splitting if true).
   * @returns First chunk content and remaining chunks to send as follow-ups.
   */
  private _prepareMessageContent(
    content: AssistantMessage["content"],
    streaming: boolean,
  ): {
    firstMessageContent: AssistantMessage["content"];
    remainingChunks: string[];
  } {
    const lastTextContent = content.findLast((c) => c.type === "text");
    const markdownChunks = lastTextContent
      ? splitMarkdownByTables(lastTextContent.text)
      : [];
    const needsSplit = !streaming && markdownChunks.length > 1;

    const firstMessageContent = needsSplit
      ? (content.map((c) =>
          c.type === "text" ? { ...c, text: markdownChunks[0] } : c,
        ) as AssistantMessage["content"])
      : content;

    const remainingChunks = needsSplit ? markdownChunks.slice(1) : [];

    return { firstMessageContent, remainingChunks };
  }

  /**
   * Send remaining markdown chunks as follow-up reply messages.
   * @param messageId - The message ID to reply to.
   * @param chunks - Array of markdown strings to send.
   */
  private async _sendRemainingChunks(
    messageId: string,
    chunks: string[],
    replyInThread = true,
  ): Promise<void> {
    for (const chunkText of chunks) {
      const chunkCard = await renderMessageCard(
        [{ type: "text", text: chunkText }],
        {
          streaming: false,
          uploadImage: this.uploadImage.bind(this),
        },
      );
      await this._client.im.message.reply({
        path: {
          message_id: messageId,
        },
        data: {
          msg_type: "interactive",
          content: JSON.stringify(chunkCard),
          reply_in_thread: replyInThread,
        },
      });
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

    const mentionEnforced = this._requireMention && chatType === "group";
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
    const userMessage: UserMessage = {
      id: messageId,
      session_id,
      role: "user",
      channel_id: this.id,
      chat_id: chatId,
      thread_id: threadId,
      sender_open_id: senderOpenId,
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
