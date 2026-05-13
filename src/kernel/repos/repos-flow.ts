import type { Logger } from "@/shared";
import {
  config,
  createLogger,
  loadPredefinedRepos,
  type CardActionPayload,
  type PredefinedRepo,
  type UserMessage,
} from "@/shared";

import type { FeishuMessageChannel } from "../../community/feishu/messaging/message-channel";
import type { Card } from "../../community/feishu/messaging/types";

import {
  buildReposDeleteConfirmCard,
  buildReposDismissedCard,
  buildReposFormCard,
  buildReposMainCard,
  buildReposResultCard,
  REPOS_ACTION,
  REPOS_FIELD,
} from "./repos-card";
import { addRepo, editRepo, removeRepo } from "./repos-writer";

/**
 * Stateful orchestrator for the `/repos` interactive flow.
 *
 * Like `/setting`, this flow doesn't track pending cards in memory — every
 * card-action payload that needs context (edit/delete target) carries the
 * `repo_name` it applies to, so handlers can re-read REPOS.md and operate
 * statelessly. A stale card from before a restart simply re-reads the
 * latest file state on the next click.
 */
export class ReposFlow {
  private readonly _logger: Logger = createLogger("repos-flow");
  private readonly _feishuChannels: Map<string, FeishuMessageChannel>;

  constructor(deps: {
    feishuChannels: Map<string, FeishuMessageChannel>;
  }) {
    this._feishuChannels = deps.feishuChannels;
  }

  /** Entry point for `/repos`. */
  async start(message: UserMessage): Promise<void> {
    const chatId = message.chat_id;
    if (!chatId || !message.channel_id) {
      await this._replyText(message, "❌ /repos 需要飞书会话上下文。");
      return;
    }
    const channel = this._feishuChannels.get(message.channel_id);
    if (!channel) {
      await this._replyText(message, "❌ 无法找到对应的飞书 channel。");
      return;
    }
    const card = this._renderMainCard();
    try {
      await channel.sendRawCard(chatId, card, {
        replyTo: message.id,
        replyInThread: false,
      });
    } catch (err) {
      this._logger.error(
        { err, chat_id: chatId },
        "failed to send repos main card",
      );
      await this._replyText(
        message,
        `❌ 渲染 /repos 卡片失败：${(err as Error).message}`,
      );
    }
  }

  /** Single entry point for every `repos_*` card action. */
  async handleAction(payload: CardActionPayload): Promise<void> {
    const channel = this._feishuChannels.get(payload.channel_id);
    if (!channel) {
      this._logger.warn(
        { channel_id: payload.channel_id, action_name: payload.action_name },
        "repos action for unknown channel",
      );
      return;
    }
    try {
      switch (payload.action_name) {
        case REPOS_ACTION.openAdd:
          await this._tryUpdateCard(
            channel,
            payload.message_id,
            buildReposFormCard({ mode: "add" }),
            "open-add",
          );
          return;
        case REPOS_ACTION.openEdit:
          await this._handleOpenEdit(channel, payload);
          return;
        case REPOS_ACTION.openDelete:
          await this._handleOpenDelete(channel, payload);
          return;
        case REPOS_ACTION.addSubmit:
          await this._handleAddSubmit(channel, payload);
          return;
        case REPOS_ACTION.editSubmit:
          await this._handleEditSubmit(channel, payload);
          return;
        case REPOS_ACTION.deleteApply:
          await this._handleDeleteApply(channel, payload);
          return;
        case REPOS_ACTION.back:
          await this._tryUpdateCard(
            channel,
            payload.message_id,
            this._renderMainCard(),
            "back",
          );
          return;
        case REPOS_ACTION.dismiss:
          await this._tryUpdateCard(
            channel,
            payload.message_id,
            buildReposDismissedCard(),
            "dismiss",
          );
          return;
        default:
          this._logger.warn(
            { action_name: payload.action_name },
            "unknown repos action",
          );
      }
    } catch (err) {
      this._logger.error(
        { err, action_name: payload.action_name },
        "repos action failed",
      );
      await this._tryUpdateCard(
        channel,
        payload.message_id,
        buildReposResultCard(`❌ 操作失败：${(err as Error).message}`),
        "action-error",
      );
    }
  }

  private async _handleOpenEdit(
    channel: FeishuMessageChannel,
    payload: CardActionPayload,
  ): Promise<void> {
    const repoName = _readRepoName(payload);
    if (!repoName) return;
    const repo = _findRepo(repoName);
    if (!repo) {
      await this._tryUpdateCard(
        channel,
        payload.message_id,
        buildReposResultCard(`⚠️  仓库 \`${repoName}\` 已不存在。`),
        "edit-missing",
      );
      return;
    }
    await this._tryUpdateCard(
      channel,
      payload.message_id,
      buildReposFormCard({ mode: "edit", initial: repo }),
      "open-edit",
    );
  }

  private async _handleOpenDelete(
    channel: FeishuMessageChannel,
    payload: CardActionPayload,
  ): Promise<void> {
    const repoName = _readRepoName(payload);
    if (!repoName) return;
    const repo = _findRepo(repoName);
    if (!repo) {
      await this._tryUpdateCard(
        channel,
        payload.message_id,
        buildReposResultCard(`⚠️  仓库 \`${repoName}\` 已不存在。`),
        "delete-missing",
      );
      return;
    }
    await this._tryUpdateCard(
      channel,
      payload.message_id,
      buildReposDeleteConfirmCard({ repo }),
      "open-delete",
    );
  }

  private async _handleAddSubmit(
    channel: FeishuMessageChannel,
    payload: CardActionPayload,
  ): Promise<void> {
    const name = _readField(payload, REPOS_FIELD.name).trim();
    const gitUrl = _readField(payload, REPOS_FIELD.gitUrl).trim();
    const description = _readField(payload, REPOS_FIELD.description).trim();
    if (!name || !gitUrl) {
      await this._tryUpdateCard(
        channel,
        payload.message_id,
        buildReposResultCard("❌ 名称和 git_url 都不能为空。"),
        "add-invalid",
      );
      return;
    }
    if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
      await this._tryUpdateCard(
        channel,
        payload.message_id,
        buildReposResultCard(
          `❌ 名称 \`${name}\` 不合法，只允许字母、数字、\`.\`、\`_\`、\`-\`。`,
        ),
        "add-invalid-name",
      );
      return;
    }
    const result = addRepo({ name, git_url: gitUrl, description });
    if (!result.ok) {
      await this._tryUpdateCard(
        channel,
        payload.message_id,
        buildReposResultCard(`❌ ${result.reason ?? "写入失败"}`),
        "add-failed",
      );
      return;
    }
    await this._tryUpdateCard(
      channel,
      payload.message_id,
      buildReposResultCard(
        `✅ 已添加 \`${name}\`。`,
        [
          `- git_url：\`${gitUrl}\``,
          description ? `- 描述：${description}` : "- 描述：(未填)",
        ],
      ),
      "add-ok",
    );
    this._logger.info({ name, git_url: gitUrl }, "repos: added");
  }

  private async _handleEditSubmit(
    channel: FeishuMessageChannel,
    payload: CardActionPayload,
  ): Promise<void> {
    const name = _readField(payload, REPOS_FIELD.name).trim();
    const gitUrl = _readField(payload, REPOS_FIELD.gitUrl).trim();
    const description = _readField(payload, REPOS_FIELD.description).trim();
    if (!name) {
      await this._tryUpdateCard(
        channel,
        payload.message_id,
        buildReposResultCard("❌ 未能识别要编辑的仓库名。"),
        "edit-missing-name",
      );
      return;
    }
    if (!gitUrl) {
      await this._tryUpdateCard(
        channel,
        payload.message_id,
        buildReposResultCard("❌ git_url 不能为空。"),
        "edit-invalid",
      );
      return;
    }
    const result = editRepo(name, { git_url: gitUrl, description });
    if (!result.ok) {
      await this._tryUpdateCard(
        channel,
        payload.message_id,
        buildReposResultCard(`❌ ${result.reason ?? "写入失败"}`),
        "edit-failed",
      );
      return;
    }
    await this._tryUpdateCard(
      channel,
      payload.message_id,
      buildReposResultCard(
        `✅ 已更新 \`${name}\`。`,
        [
          `- git_url：\`${gitUrl}\``,
          description ? `- 描述：${description}` : "- 描述：(未填)",
        ],
      ),
      "edit-ok",
    );
    this._logger.info({ name, git_url: gitUrl }, "repos: edited");
  }

  private async _handleDeleteApply(
    channel: FeishuMessageChannel,
    payload: CardActionPayload,
  ): Promise<void> {
    const repoName = _readRepoName(payload);
    if (!repoName) return;
    const result = removeRepo(repoName);
    if (!result.ok) {
      await this._tryUpdateCard(
        channel,
        payload.message_id,
        buildReposResultCard(`❌ ${result.reason ?? "删除失败"}`),
        "delete-failed",
      );
      return;
    }
    await this._tryUpdateCard(
      channel,
      payload.message_id,
      buildReposResultCard(`✅ 已删除 \`${repoName}\`。`),
      "delete-ok",
    );
    this._logger.info({ name: repoName }, "repos: removed");
  }

  private _renderMainCard(): Card {
    return buildReposMainCard({
      repos: loadPredefinedRepos(),
      file_path: config.paths.repos_md,
    });
  }

  private async _tryUpdateCard(
    channel: FeishuMessageChannel,
    messageId: string,
    card: Card,
    stage: string,
  ): Promise<void> {
    try {
      await channel.updateRawCard(messageId, card);
    } catch (err) {
      this._logger.error(
        { err, stage, message_id: messageId },
        "repos updateRawCard failed",
      );
    }
  }

  private async _replyText(
    message: UserMessage,
    text: string,
  ): Promise<void> {
    if (!message.channel_id) return;
    const channel = this._feishuChannels.get(message.channel_id);
    if (!channel) return;
    await channel.replyMessage(
      message.id,
      {
        role: "assistant",
        session_id: message.session_id,
        content: [{ type: "text", text }],
      },
      { streaming: false, replyInThread: false },
    );
  }
}

function _readRepoName(payload: CardActionPayload): string | null {
  const name = payload.value.repo_name;
  return typeof name === "string" && name ? name : null;
}

function _readField(payload: CardActionPayload, key: string): string {
  const raw = payload.form_value[key];
  return typeof raw === "string" ? raw : "";
}

function _findRepo(name: string): PredefinedRepo | null {
  return loadPredefinedRepos().find((r) => r.name === name) ?? null;
}
