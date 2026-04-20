import type { DrizzleDB } from "@/data";
import type { Logger } from "@/shared";
import { createLogger, uuid, type UserMessage } from "@/shared";

import { feishuBotGroups } from "../../community/feishu/messaging/data";
import type { FeishuMessageChannel } from "../../community/feishu/messaging/message-channel";
import type { SetupFlow } from "../setup/setup-flow";

/**
 * Orchestrates the `/group <name> @user1 @user2` command.
 *
 * Flow:
 * 1. Validate P2P-only + at least one @-mention.
 * 2. Create a group via Feishu API with the sender + mentioned users.
 * 3. Transfer ownership from the bot to the sender.
 * 4. Persist the chat to `feishu_bot_groups` so `/ungroup` can look it up.
 * 5. Post a welcome line in the new group and anchor an auto-triggered
 *    `/setup` card to it (so the new group is initialized for a workspace).
 * 6. Confirm back to the P2P sender.
 *
 * One-shot: no pending state is tracked on the instance — all lookup data
 * lives in the DB.
 */
export class GroupFlow {
  private readonly _logger: Logger = createLogger("group-flow");
  private readonly _feishuChannels: Map<string, FeishuMessageChannel>;
  private readonly _setupFlow: SetupFlow;
  private readonly _db: DrizzleDB;

  constructor(deps: {
    feishuChannels: Map<string, FeishuMessageChannel>;
    setupFlow: SetupFlow;
    db: DrizzleDB;
  }) {
    this._feishuChannels = deps.feishuChannels;
    this._setupFlow = deps.setupFlow;
    this._db = deps.db;
  }

  async start(message: UserMessage): Promise<void> {
    if (message.chat_type !== "single") {
      await this._replyText(
        message,
        "❌ /group 仅在与机器人的单聊中可用。",
      );
      return;
    }
    if (!message.channel_id || !message.chat_id) {
      await this._replyText(message, "❌ /group 缺少会话上下文。");
      return;
    }
    const senderOpenId = message.sender_open_id;
    if (!senderOpenId) {
      await this._replyText(
        message,
        "❌ 无法识别发命令的用户，请稍后重试。",
      );
      return;
    }
    const channel = this._feishuChannels.get(message.channel_id);
    if (!channel) {
      await this._replyText(message, "❌ 无法找到对应的飞书 channel。");
      return;
    }

    const parsed = this._parseArgs(message, senderOpenId, channel.botOpenId);
    if ("error" in parsed) {
      await this._replyText(message, parsed.error);
      return;
    }
    const { name, memberOpenIds } = parsed;

    // The sender must be in the chat to become the owner; dedup in case
    // they also @'d themselves. The bot is always auto-added by Feishu as
    // the creator, no need to include it here.
    const allMembers = Array.from(new Set([senderOpenId, ...memberOpenIds]));

    let chatId: string;
    try {
      chatId = await channel.createChat({
        name,
        memberOpenIds: allMembers,
      });
    } catch (err) {
      this._logger.error(
        { err, name, members: allMembers },
        "createChat failed",
      );
      await this._replyText(
        message,
        `❌ 建群失败：${(err as Error).message}`,
      );
      return;
    }

    try {
      await channel.transferChatOwner(chatId, senderOpenId);
    } catch (err) {
      // Non-fatal: the group exists and members are in. Warn the user so
      // they know the bot is still owner and can transfer manually.
      this._logger.error(
        { err, chat_id: chatId, new_owner: senderOpenId },
        "transferChatOwner failed",
      );
      await this._replyText(
        message,
        `⚠️  群已建（\`${chatId}\`），但群主转让失败：${
          (err as Error).message
        }。机器人仍是群主，可稍后手动转让。`,
      );
    }

    this._db
      .insert(feishuBotGroups)
      .values({
        chat_id: chatId,
        channel_id: channel.id,
        chat_name: name,
        creator_open_id: senderOpenId,
        created_at: Date.now(),
      })
      .onConflictDoNothing()
      .run();

    // Post a welcome line first so `/setup` has a real message_id to anchor
    // its card reply to — SetupFlow.start reuses message.id as `replyTo`.
    let welcomeMessageId: string;
    try {
      welcomeMessageId = await channel.sendPlainText(
        chatId,
        "✅ 群已建好，下面请填写 /setup 卡片初始化 workspace。",
      );
    } catch (err) {
      this._logger.error(
        { err, chat_id: chatId },
        "sendPlainText failed; skipping auto-setup",
      );
      await this._replyText(
        message,
        `✅ 已建群 \`${name}\` (\`${chatId}\`)，但自动发 /setup 卡片失败：${
          (err as Error).message
        }。请在群里 @ 机器人发 \`/setup\` 继续。`,
      );
      return;
    }

    const synthetic: UserMessage = {
      id: welcomeMessageId,
      session_id: uuid(),
      role: "user",
      channel_id: channel.id,
      chat_id: chatId,
      chat_type: "group",
      sender_open_id: senderOpenId,
      content: [{ type: "text", text: "" }],
    };
    try {
      await this._setupFlow.start(synthetic);
    } catch (err) {
      this._logger.error(
        { err, chat_id: chatId },
        "auto /setup failed",
      );
      await this._replyText(
        message,
        `✅ 已建群 \`${name}\`，但自动 /setup 失败：${
          (err as Error).message
        }。请在群里 @ 机器人发 \`/setup\` 继续。`,
      );
      return;
    }

    await this._replyText(
      message,
      `✅ 已建群 \`${name}\`（${
        allMembers.length
      } 人），并在群里发出 /setup 卡片。`,
    );
  }

  private _parseArgs(
    message: UserMessage,
    senderOpenId: string,
    botOpenId: string | undefined,
  ):
    | { name: string; memberOpenIds: string[] }
    | { error: string } {
    const mentions = message.mentions ?? [];
    if (mentions.length === 0) {
      return {
        error:
          "用法：`/group <群名> @user1 @user2 ...`（至少 @ 一个人）",
      };
    }
    const seen = new Set<string>();
    const memberOpenIds: string[] = [];
    for (const m of mentions) {
      // Skip self — `/group` is issued by the sender, they're always in the
      // new chat. Skip the bot too — Feishu auto-adds the creator, and
      // we don't want `@bot /group …` to inflate the member count.
      if (m.open_id === senderOpenId) continue;
      if (botOpenId && m.open_id === botOpenId) continue;
      if (seen.has(m.open_id)) continue;
      seen.add(m.open_id);
      memberOpenIds.push(m.open_id);
    }
    if (memberOpenIds.length === 0) {
      return { error: "❌ 没有识别到被 @ 的其他成员（自己不算）。" };
    }

    // Name is everything between `/group ` and the first mention placeholder.
    // Use the message's text content verbatim — mentions carry `key`
    // substrings (e.g. `@_user_0`) so we can split on the earliest one.
    const text = message.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join(" ")
      .trim();
    const stripped = text.replace(/^\/group\b/, "").trim();
    let earliestIdx = stripped.length;
    for (const m of mentions) {
      if (!m.key) continue;
      const idx = stripped.indexOf(m.key);
      if (idx >= 0 && idx < earliestIdx) earliestIdx = idx;
    }
    const rawName = stripped.slice(0, earliestIdx).trim();
    if (!rawName) {
      return {
        error: "❌ 群名不能为空。用法：`/group <群名> @user1 ...`",
      };
    }
    return { name: rawName, memberOpenIds };
  }

  private async _replyText(
    message: UserMessage,
    text: string,
  ): Promise<void> {
    if (!message.channel_id) return;
    const channel = this._feishuChannels.get(message.channel_id);
    if (!channel) return;
    try {
      await channel.replyMessage(
        message.id,
        {
          role: "assistant",
          session_id: message.session_id,
          content: [{ type: "text", text }],
        },
        { streaming: false, replyInThread: false },
      );
    } catch (err) {
      this._logger.warn({ err }, "group-flow _replyText failed");
    }
  }
}
