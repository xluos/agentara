import type { Logger } from "@/shared";
import {
  createLogger,
  type CardActionPayload,
  type UserMessage,
} from "@/shared";

import type { FeishuMessageChannel } from "../../community/feishu/messaging/message-channel";
import type { GroupWorkspaceStore } from "../workspaces";

import {
  buildSwitchCard,
  buildSwitchResultCard,
  SWITCH_DETACH_VALUE,
  SWITCH_FIELD,
} from "./switch-card";

/**
 * In-memory pending state for a `/switch` card that has been sent but not
 * yet submitted. Dropped on kernel restart — expired cards surface a clear
 * error back to the user instead of being silently honored.
 */
interface PendingSwitch {
  chat_id: string;
  initiator_open_id: string;
  /** Snapshot of valid workspace ids at card-render time, for validation on submit. */
  valid_workspace_ids: Set<string>;
  created_at: number;
}

/**
 * Stateful orchestrator for the `/switch` interactive flow.
 *
 * Lifecycle:
 * 1. `start(message)` lists all known workspaces, renders the card, and
 *    remembers the id snapshot keyed by the outbound message id.
 * 2. The kernel routes a `card:action` with `action_name === "switch_submit"`
 *    to `handleSubmit(payload)`.
 * 3. The handler applies the binding change (switch or detach) and replaces
 *    the card in place with a result card.
 *
 * Unlike `/setup`, `/switch` is available in both group chats and single
 * chats (P2P) — its only job is re-pointing the chat's binding at an
 * already-existing workspace, no filesystem mutation.
 */
export class SwitchFlow {
  private readonly _logger: Logger = createLogger("switch-flow");
  private readonly _workspaceStore: GroupWorkspaceStore;
  private readonly _feishuChannels: Map<string, FeishuMessageChannel>;
  private readonly _pending = new Map<string, PendingSwitch>();

  constructor(deps: {
    workspaceStore: GroupWorkspaceStore;
    feishuChannels: Map<string, FeishuMessageChannel>;
  }) {
    this._workspaceStore = deps.workspaceStore;
    this._feishuChannels = deps.feishuChannels;
  }

  /**
   * Entry point invoked from `kernel._handleInboundMessage` when the inbound
   * text is `/switch`. Works in both group and P2P Feishu chats since the
   * binding is keyed purely on `chat_id`.
   */
  async start(message: UserMessage): Promise<void> {
    const chatId = message.chat_id;
    if (!chatId || !message.channel_id) {
      await this._replyText(
        message,
        "❌ /switch 需要飞书会话上下文（群聊或单聊均可）。",
      );
      return;
    }
    const channel = this._feishuChannels.get(message.channel_id);
    if (!channel) {
      await this._replyText(message, "❌ 无法找到对应的飞书 channel。");
      return;
    }

    const workspaces = this._workspaceStore.listWorkspaces();
    if (workspaces.length === 0) {
      await this._replyText(
        message,
        [
          "ℹ️  还没有任何 workspace。",
          "请先在某个群里执行 `/setup` 创建一个，然后回到这里 `/switch` 挑选。",
        ].join("\n"),
      );
      return;
    }

    const current = this._workspaceStore.getBinding(chatId);
    const sortedWorkspaces = [...workspaces].sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    const card = buildSwitchCard({
      workspaces: sortedWorkspaces,
      current: current
        ? {
            workspace_id: current.workspace_id,
            workspace_name: current.workspace_name,
            workspace_path: current.workspace_path,
            active_repo: current.active_repo,
            active_branch: current.active_branch,
          }
        : undefined,
    });
    const cardMessageId = await channel.sendRawCard(chatId, card, {
      replyTo: message.id,
    });
    this._pending.set(cardMessageId, {
      chat_id: chatId,
      initiator_open_id: message.sender_open_id ?? "",
      valid_workspace_ids: new Set(sortedWorkspaces.map((ws) => ws.id)),
      created_at: Date.now(),
    });
    this._logger.info(
      {
        chat_id: chatId,
        card_message_id: cardMessageId,
        workspace_count: sortedWorkspaces.length,
      },
      "switch card sent",
    );
  }

  /**
   * Entry point invoked from the kernel's `card:action` listener when the
   * payload's `action_name === "switch_submit"`. Looks up pending state by
   * `payload.message_id`, validates, and applies the binding change.
   */
  async handleSubmit(payload: CardActionPayload): Promise<void> {
    const channel = this._feishuChannels.get(payload.channel_id);
    if (!channel) {
      this._logger.warn(
        { channel_id: payload.channel_id },
        "received switch card action for unknown channel",
      );
      return;
    }
    const pending = this._pending.get(payload.message_id);
    if (!pending) {
      await this._tryUpdateCard(
        channel,
        payload.message_id,
        buildSwitchResultCard("⚠️  这张卡片已失效，请重新发送 `/switch`。"),
        "expired",
      );
      return;
    }
    if (
      pending.initiator_open_id &&
      payload.operator_open_id !== pending.initiator_open_id
    ) {
      await this._tryUpdateCard(
        channel,
        payload.message_id,
        buildSwitchResultCard("🚫 这不是你的表单。"),
        "non-initiator",
      );
      return;
    }

    this._pending.delete(payload.message_id);

    const rawPick = payload.form_value[SWITCH_FIELD.workspaceId];
    const pick = typeof rawPick === "string" ? rawPick : "";

    if (pick === SWITCH_DETACH_VALUE) {
      const removed = this._workspaceStore.deleteBinding(pending.chat_id);
      const msg = removed
        ? "✅ 已取消绑定，当前会话回到默认 workspace。"
        : "ℹ️  当前会话本来就没有绑定，回到默认 workspace。";
      await this._tryUpdateCard(
        channel,
        payload.message_id,
        buildSwitchResultCard(msg),
        "detached",
      );
      this._logger.info(
        { chat_id: pending.chat_id, removed },
        "switch card: detached",
      );
      return;
    }

    if (!pick || !pending.valid_workspace_ids.has(pick)) {
      await this._tryUpdateCard(
        channel,
        payload.message_id,
        buildSwitchResultCard(
          "⚠️  选择的 workspace 已不存在，请重新发送 `/switch`。",
        ),
        "invalid-selection",
      );
      return;
    }

    let binding;
    try {
      binding = this._workspaceStore.upsertBinding(pending.chat_id, {
        workspace_id: pick,
      });
    } catch (err) {
      this._logger.error(
        { err, chat_id: pending.chat_id, workspace_id: pick },
        "switch card: upsertBinding failed",
      );
      await this._tryUpdateCard(
        channel,
        payload.message_id,
        buildSwitchResultCard(
          `❌ 绑定失败：${(err as Error).message}`,
        ),
        "upsert-failed",
      );
      return;
    }

    const summary = `✅ 已切换到 workspace \`${binding.workspace_name}\`。`;
    const detail = [
      `- Workspace ID：\`${binding.workspace_id}\``,
      `- 活跃仓库：\`${binding.active_repo ?? "(未设置)"}\``,
      `- 活跃分支：\`${binding.active_branch ?? "(未设置)"}\``,
    ];
    await this._tryUpdateCard(
      channel,
      payload.message_id,
      buildSwitchResultCard(summary, detail),
      "final-result",
    );
    this._logger.info(
      { chat_id: pending.chat_id, workspace_id: binding.workspace_id },
      "switch card: binding updated",
    );
  }

  private async _tryUpdateCard(
    channel: FeishuMessageChannel,
    messageId: string,
    card: ReturnType<typeof buildSwitchResultCard>,
    stage: string,
  ): Promise<void> {
    try {
      await channel.updateRawCard(messageId, card);
    } catch (err) {
      this._logger.error(
        { err, stage, message_id: messageId },
        "updateRawCard failed",
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
