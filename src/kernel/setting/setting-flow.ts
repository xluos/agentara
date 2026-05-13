import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { eq, like, or } from "drizzle-orm";

import type { DrizzleDB } from "@/data";
import {
  filterUserFacingAgentTypes,
  getAgentRuntimeState,
  listRunnerTypes,
  setRuntimeDefaultAgentType,
  UnknownAgentTypeError,
} from "@/kernel/agents";
import { sessions } from "@/kernel/sessioning/data";
import {
  readRepoHead,
  WorkspaceNotFoundError,
  WorkspaceProtectedError,
  type GroupWorkspaceStore,
  type WorkspaceDeleteResult,
} from "@/kernel/workspaces";
import type { GroupWorkspace, Logger, Workspace } from "@/shared";
import { config, createLogger, type CardActionPayload, type UserMessage } from "@/shared";

import type { FeishuMessageChannel } from "../../community/feishu/messaging/message-channel";
import type { Card } from "../../community/feishu/messaging/types";

import { writeConfigPatch, type SettingConfigPatch } from "./config-writer";
import {
  buildSettingMainCard,
  buildSettingResultCard,
  buildWorkspaceDeleteConfirmCard,
  buildWorkspaceDetailCard,
  SETTING_ACTION,
  SETTING_FIELD,
} from "./setting-card";

/**
 * Stateful orchestrator for the `/setting` panel.
 *
 * Lifecycle:
 * 1. `start(message)` renders the main panel (global config form + workspace
 *    list) into the chat and returns.
 * 2. Every subsequent click routes back through `handleAction(payload)`,
 *    which replaces the card in place (`updateRawCard`) with a detail view,
 *    a delete-confirm view, or a terminal result.
 *
 * Unlike `/setup`/`/switch`, we intentionally don't track pending cards in
 * an in-memory map: every action payload carries the `workspace_id` it
 * applies to, so we can operate statelessly. A stale card from before a
 * restart still works — the worst case is pointing at a workspace that has
 * since been deleted, which the flow handles gracefully.
 */
export class SettingFlow {
  private readonly _logger: Logger = createLogger("setting-flow");
  private readonly _workspaceStore: GroupWorkspaceStore;
  private readonly _feishuChannels: Map<string, FeishuMessageChannel>;
  private readonly _db: DrizzleDB;

  constructor(deps: {
    workspaceStore: GroupWorkspaceStore;
    feishuChannels: Map<string, FeishuMessageChannel>;
    db: DrizzleDB;
  }) {
    this._workspaceStore = deps.workspaceStore;
    this._feishuChannels = deps.feishuChannels;
    this._db = deps.db;
  }

  /** Entry point for `/setting` and `/workspaces`. */
  async start(message: UserMessage): Promise<void> {
    const chatId = message.chat_id;
    if (!chatId || !message.channel_id) {
      await this._replyText(message, "❌ /setting 需要飞书会话上下文。");
      return;
    }
    if (!this._isAdmin(message.sender_open_id)) {
      this._logger.info(
        { chat_id: chatId, sender_open_id: message.sender_open_id },
        "rejected /setting from non-admin",
      );
      await this._replyText(
        message,
        "🚫 你没有 /setting 权限。请联系管理员把你的 open_id 加到 `setting.admin_open_ids`。",
      );
      return;
    }
    const channel = this._feishuChannels.get(message.channel_id);
    if (!channel) {
      await this._replyText(message, "❌ 无法找到对应的飞书 channel。");
      return;
    }
    try {
      const card = this._renderMainCard(chatId);
      await channel.sendRawCard(chatId, card, {
        replyTo: message.id,
        replyInThread: false,
      });
    } catch (err) {
      const detail = _summarizeFeishuError(err);
      this._logger.error(
        { err: detail, chat_id: chatId },
        "failed to render setting card",
      );
      const reason = detail.msg
        ? `${detail.msg}${detail.code ? ` (code ${detail.code})` : ""}`
        : (err as Error).message;
      await this._replyText(message, `❌ 渲染设置面板失败：${reason}`);
    }
  }

  /** Single entry point for every `setting_*` card action. */
  async handleAction(payload: CardActionPayload): Promise<void> {
    const channel = this._feishuChannels.get(payload.channel_id);
    if (!channel) {
      this._logger.warn(
        { channel_id: payload.channel_id, action_name: payload.action_name },
        "setting action for unknown channel",
      );
      return;
    }
    if (!this._isAdmin(payload.operator_open_id)) {
      this._logger.info(
        {
          action_name: payload.action_name,
          operator_open_id: payload.operator_open_id,
        },
        "rejected /setting card action from non-admin",
      );
      await this._tryUpdateCard(
        channel,
        payload.message_id,
        buildSettingResultCard(
          "🚫 你没有 /setting 权限，无法操作此卡片。",
          [],
          { show_back: false },
        ),
        "non-admin",
      );
      return;
    }
    try {
      switch (payload.action_name) {
        case SETTING_ACTION.saveConfig:
          await this._handleSaveConfig(channel, payload);
          return;
        case SETTING_ACTION.mainBack:
          await this._handleMainBack(channel, payload);
          return;
        case SETTING_ACTION.wsDetail:
          await this._handleWsDetail(channel, payload);
          return;
        case SETTING_ACTION.wsDeletePrompt:
          await this._handleWsDeletePrompt(channel, payload);
          return;
        case SETTING_ACTION.wsDeleteApply:
          await this._handleWsDeleteApply(channel, payload);
          return;
        default:
          this._logger.warn(
            { action_name: payload.action_name },
            "unknown setting action",
          );
      }
    } catch (err) {
      this._logger.error(
        { err, action_name: payload.action_name },
        "setting action failed",
      );
      await this._tryUpdateCard(
        channel,
        payload.message_id,
        buildSettingResultCard(`❌ 操作失败：${(err as Error).message}`),
        "action-error",
      );
    }
  }

  private async _handleSaveConfig(
    channel: FeishuMessageChannel,
    payload: CardActionPayload,
  ): Promise<void> {
    const raw = payload.form_value;
    const newAgentType =
      typeof raw[SETTING_FIELD.agentType] === "string"
        ? (raw[SETTING_FIELD.agentType] as string).trim()
        : "";
    const newAgentModel =
      typeof raw[SETTING_FIELD.agentModel] === "string"
        ? (raw[SETTING_FIELD.agentModel] as string).trim()
        : "";
    const newCodexIsolate = _coerceBool(raw[SETTING_FIELD.codexIsolateHostEnv]);
    const parsedRetries = _coerceInt(raw[SETTING_FIELD.maxRetries]);

    if (parsedRetries === null || parsedRetries <= 0) {
      await this._tryUpdateCard(
        channel,
        payload.message_id,
        buildSettingResultCard(
          "❌ 任务重试上限必须为正整数，未保存任何改动。",
        ),
        "invalid-retries",
      );
      return;
    }

    const patch: SettingConfigPatch = {
      agents: {
        default: {
          type: newAgentType || undefined,
          model: newAgentModel,
        },
        codex: {
          isolate_host_env: newCodexIsolate,
        },
      },
      tasking: {
        max_retries: parsedRetries,
      },
    };

    const appliedLines: string[] = [];
    try {
      writeConfigPatch(patch);
      appliedLines.push(
        `- 默认 Agent（配置）：\`${newAgentType || "(未变)"}\``,
        `- Agent Model：\`${newAgentModel || "(未设置)"}\``,
        `- Codex 环境隔离：${newCodexIsolate ? "✅ 开启" : "⬜ 关闭"}`,
        `- 任务重试上限：\`${parsedRetries}\``,
      );
    } catch (err) {
      await this._tryUpdateCard(
        channel,
        payload.message_id,
        buildSettingResultCard(
          `❌ 写入 config.yaml 失败：${(err as Error).message}`,
        ),
        "write-failed",
      );
      return;
    }

    // Keep the runtime override in sync with the configured default when the
    // user picks a new Agent. Any invalid type throws — we surface it but
    // still keep the file-level change, since the YAML write already landed.
    if (newAgentType) {
      try {
        const result = setRuntimeDefaultAgentType(newAgentType);
        appliedLines.push(
          result.changed
            ? `- 运行时默认 Agent：\`${result.previousType}\` → \`${result.currentType}\``
            : `- 运行时默认 Agent：\`${result.currentType}\`（未变）`,
        );
      } catch (err) {
        if (err instanceof UnknownAgentTypeError) {
          appliedLines.push(
            `- ⚠️  运行时 Agent 未切换：\`${err.type}\` 不在可用列表 [${err.availableTypes.join(", ")}]`,
          );
        } else {
          throw err;
        }
      }
    }

    await this._tryUpdateCard(
      channel,
      payload.message_id,
      buildSettingResultCard("✅ 配置已保存。", appliedLines),
      "save-ok",
    );
  }

  private async _handleMainBack(
    channel: FeishuMessageChannel,
    payload: CardActionPayload,
  ): Promise<void> {
    const card = this._renderMainCard(payload.chat_id ?? null);
    await this._tryUpdateCard(channel, payload.message_id, card, "main-back");
  }

  private async _handleWsDetail(
    channel: FeishuMessageChannel,
    payload: CardActionPayload,
  ): Promise<void> {
    const workspaceId = _readWorkspaceId(payload);
    if (!workspaceId) return;
    const workspace = this._workspaceStore.getWorkspace(workspaceId);
    if (!workspace) {
      await this._tryUpdateCard(
        channel,
        payload.message_id,
        buildSettingResultCard("⚠️  workspace 已不存在，请重新发送 `/setting`。"),
        "ws-missing",
      );
      return;
    }
    const bindings = this._workspaceStore
      .listBindings()
      .filter((b) => b.workspace_id === workspaceId);
    const repos = _scanRepos(workspace);
    const activeBranchHead = workspace.active_repo
      ? readRepoHead(join(workspace.path, workspace.active_repo)) ?? null
      : null;
    await this._tryUpdateCard(
      channel,
      payload.message_id,
      buildWorkspaceDetailCard({
        workspace,
        bindings,
        repos,
        is_protected: workspace.path === config.paths.default_workspace,
        active_branch_head: activeBranchHead,
      }),
      "ws-detail",
    );
  }

  private async _handleWsDeletePrompt(
    channel: FeishuMessageChannel,
    payload: CardActionPayload,
  ): Promise<void> {
    const workspaceId = _readWorkspaceId(payload);
    if (!workspaceId) return;
    const workspace = this._workspaceStore.getWorkspace(workspaceId);
    if (!workspace) {
      await this._tryUpdateCard(
        channel,
        payload.message_id,
        buildSettingResultCard("⚠️  workspace 已不存在。"),
        "ws-missing",
      );
      return;
    }
    const bindingCount = this._workspaceStore
      .listBindings()
      .filter((b) => b.workspace_id === workspaceId).length;
    const sessionCount = this._countSessionsInWorkspace(workspace.path);
    await this._tryUpdateCard(
      channel,
      payload.message_id,
      buildWorkspaceDeleteConfirmCard({
        workspace,
        binding_count: bindingCount,
        estimated_session_count: sessionCount,
      }),
      "ws-delete-prompt",
    );
  }

  private async _handleWsDeleteApply(
    channel: FeishuMessageChannel,
    payload: CardActionPayload,
  ): Promise<void> {
    const workspaceId = _readWorkspaceId(payload);
    if (!workspaceId) return;
    let result: WorkspaceDeleteResult;
    try {
      result = this._workspaceStore.deleteWorkspace(workspaceId);
    } catch (err) {
      if (err instanceof WorkspaceNotFoundError) {
        await this._tryUpdateCard(
          channel,
          payload.message_id,
          buildSettingResultCard("⚠️  workspace 已不存在。"),
          "ws-missing",
        );
        return;
      }
      if (err instanceof WorkspaceProtectedError) {
        await this._tryUpdateCard(
          channel,
          payload.message_id,
          buildSettingResultCard("🚫 默认 workspace 受保护，无法删除。"),
          "ws-protected",
        );
        return;
      }
      throw err;
    }
    const lines = [
      `- 名称：\`${result.workspace_name}\``,
      `- ID：\`${result.workspace_id}\``,
      `- 已解绑 **${result.removed_bindings}** 个群`,
      `- 已级联删除 **${result.removed_sessions}** 个 session，**${result.removed_tasks}** 条 task 记录`,
      result.removed_directory
        ? "- 已删除物理目录"
        : "- ⚠️  物理目录未能删除（可能已不存在或权限问题），详见日志",
    ];
    await this._tryUpdateCard(
      channel,
      payload.message_id,
      buildSettingResultCard(
        `✅ 已删除 workspace \`${result.workspace_name}\`。`,
        lines,
      ),
      "ws-delete-apply",
    );
  }

  private _renderMainCard(currentChatId: string | null): Card {
    const agentState = getAgentRuntimeState();
    const availableTypes = filterUserFacingAgentTypes(
      agentState.availableTypes.length > 0
        ? agentState.availableTypes
        : listRunnerTypes(),
    );
    const workspaces = this._workspaceStore.listWorkspaces();
    const bindings = this._workspaceStore.listBindings();
    const bindingCounts = new Map<string, number>();
    for (const b of bindings) {
      bindingCounts.set(
        b.workspace_id,
        (bindingCounts.get(b.workspace_id) ?? 0) + 1,
      );
    }
    const currentBinding = currentChatId
      ? bindings.find((b) => b.chat_id === currentChatId)
      : undefined;
    const sortedWorkspaces = [...workspaces].sort(
      (a, b) => b.last_active_at - a.last_active_at,
    );
    return buildSettingMainCard({
      agent: {
        active_type: agentState.activeType,
        available_types: availableTypes,
      },
      config_values: {
        agent_model: config.agents.default.model ?? "",
        codex_isolate_host_env: config.agents.codex.isolate_host_env,
        max_retries: config.tasking.max_retries,
      },
      workspaces: sortedWorkspaces.map((ws) => ({
        workspace: ws,
        binding_count: bindingCounts.get(ws.id) ?? 0,
        is_current: currentBinding?.workspace_id === ws.id,
        is_protected: ws.path === config.paths.default_workspace,
        active_branch_head: ws.active_repo
          ? readRepoHead(join(ws.path, ws.active_repo)) ?? null
          : null,
      })),
      current_chat_id: currentChatId,
    });
  }

  private _countSessionsInWorkspace(workspacePath: string): number {
    const rows = this._db
      .select({ id: sessions.id })
      .from(sessions)
      .where(
        or(
          eq(sessions.cwd, workspacePath),
          like(sessions.cwd, `${workspacePath}/%`),
        ),
      )
      .all();
    return rows.length;
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
        { err: _summarizeFeishuError(err), stage, message_id: messageId },
        "setting updateRawCard failed",
      );
    }
  }

  /**
   * Allowlist gate for `/setting`. Empty `setting.admin_open_ids` means no
   * restriction (every channel-allowed user may use the panel); otherwise
   * the sender's open_id must be in the list. Missing `senderOpenId` is
   * always rejected once a non-empty list is configured.
   */
  private _isAdmin(senderOpenId: string | undefined | null): boolean {
    const adminIds = config.setting.admin_open_ids;
    if (adminIds.length === 0) return true;
    return !!senderOpenId && adminIds.includes(senderOpenId);
  }

  private async _replyText(message: UserMessage, text: string): Promise<void> {
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

function _readWorkspaceId(payload: CardActionPayload): string | null {
  const wsId = payload.value.workspace_id;
  return typeof wsId === "string" && wsId ? wsId : null;
}

function _coerceBool(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    const lower = v.toLowerCase();
    return lower === "true" || lower === "1" || lower === "on";
  }
  return false;
}

function _coerceInt(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === "string") {
    const parsed = parseInt(v.trim(), 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

interface RepoSummary {
  name: string;
  branch: string | null;
  is_active: boolean;
}

function _scanRepos(workspace: Workspace): RepoSummary[] {
  let entries: string[];
  try {
    entries = readdirSync(workspace.path, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .filter((name) => !name.startsWith("."));
  } catch {
    return [];
  }
  const repos: RepoSummary[] = [];
  for (const name of entries) {
    const repoPath = join(workspace.path, name);
    if (!existsSync(join(repoPath, ".git"))) continue;
    const head = readRepoHead(repoPath);
    repos.push({
      name,
      branch: head ?? null,
      is_active: name === workspace.active_repo,
    });
  }
  return repos.sort((a, b) => a.name.localeCompare(b.name));
}

// Expose GroupWorkspace so `_handleWsDetail` callers don't need to import from
// deep paths — not used today but keeps the barrel clean if we ever surface
// binding details publicly.
export type { GroupWorkspace };

/**
 * Extract the code/msg/status trio from a Feishu/axios error so logs and
 * user-facing messages carry the actual server reason instead of the generic
 * "Request failed with status code 400".
 */
function _summarizeFeishuError(err: unknown): {
  code?: number;
  msg?: string;
  status?: number;
} {
  if (!err || typeof err !== "object") return {};
  const candidate = err as {
    response?: {
      status?: number;
      data?: { code?: number; msg?: string };
    };
    message?: string;
  };
  return {
    code: candidate.response?.data?.code,
    msg: candidate.response?.data?.msg ?? candidate.message,
    status: candidate.response?.status,
  };
}
