import dayjs from "dayjs";

import { formatRepoRef } from "@/kernel/repo-ref";
import type { GroupWorkspace, Workspace } from "@/shared";

import type {
  ButtonElement,
  Card,
  CheckerElement,
  Element,
  FormElement,
  InputElement,
  SelectStaticElement,
} from "../../community/feishu/messaging/types";
import {
  buildCardIntro,
  buildMarkdown,
  buildResultCard,
  buildSectionBlock,
} from "../setup/card-ui";

/**
 * Action discriminators for every interactive element on `/setting` cards.
 * `setting_save_config` is a form_submit button (Feishu echoes the button
 * name as `action_name`); the rest are callback buttons whose `value.action`
 * drives routing. All names share the `setting_` prefix so the kernel can
 * forward them to the flow with a single `startsWith` check.
 */
export const SETTING_ACTION = {
  saveConfig: "setting_save_config",
  mainBack: "setting_main_back",
  wsDetail: "setting_ws_detail",
  wsDeletePrompt: "setting_ws_delete_prompt",
  wsDeleteApply: "setting_ws_delete_apply",
} as const;

/**
 * Form field names for the global-config section of the main card. Shared
 * between renderer and submit handler so the two cannot drift.
 */
export const SETTING_FIELD = {
  agentType: "agent_type",
  agentModel: "agent_model",
  codexIsolateHostEnv: "codex_isolate_host_env",
  maxRetries: "max_retries",
} as const;

/**
 * Snapshot of everything the main card needs to render. Flow resolves these
 * once per render and passes them in; the card file stays pure.
 */
export interface SettingMainCardOptions {
  agent: {
    active_type: string;
    available_types: string[];
  };
  config_values: {
    agent_model: string;
    codex_isolate_host_env: boolean;
    max_retries: number;
  };
  workspaces: Array<{
    workspace: Workspace;
    binding_count: number;
    is_current: boolean;
  }>;
  current_chat_id?: string | null;
}

/**
 * Top-level `/setting` panel: a global-config form on top, a workspace list
 * beneath. Each workspace row has a "详情" callback button that swaps the
 * card for a detail view in place via `updateRawCard`.
 */
export function buildSettingMainCard(options: SettingMainCardOptions): Card {
  const elements: Element[] = [
    buildCardIntro({
      title: "设置面板",
      subtitle: "全局运行时 + workspace 管理",
    }),
    _buildConfigForm(options),
    buildMarkdown("**Workspace 管理**"),
  ];

  if (options.workspaces.length === 0) {
    elements.push(
      buildMarkdown("<font color='grey'>还没有任何 workspace。在群里执行 `/setup` 创建一个。</font>"),
    );
  } else {
    for (const entry of options.workspaces) {
      elements.push(_buildWorkspaceRow(entry));
    }
  }

  return {
    schema: "2.0",
    config: {
      streaming_mode: false,
      update_multi: true,
      width_mode: "fill",
      summary: { content: "⚙️ 设置面板" },
    },
    body: {
      padding: "12px 16px 16px 16px",
      vertical_spacing: "12px",
      elements,
    },
  };
}

/**
 * Detail card for one workspace: metadata, cloned repos + branches, list of
 * bound chats, danger button that leads to the delete-confirm card.
 */
export interface WorkspaceDetailCardOptions {
  workspace: Workspace;
  bindings: GroupWorkspace[];
  repos: Array<{ name: string; branch: string | null; is_active: boolean }>;
  is_protected: boolean;
}

export function buildWorkspaceDetailCard(
  options: WorkspaceDetailCardOptions,
): Card {
  const { workspace, bindings, repos, is_protected } = options;
  const activeRepoLine = workspace.active_repo
    ? `\`${formatRepoRef(workspace.active_repo, workspace.active_branch ?? "")}\``
    : "(未设置)";

  const elements: Element[] = [
    buildCardIntro({
      title: `Workspace: ${workspace.name}`,
      subtitle: workspace.id,
    }),
    ...buildSectionBlock({
      title: "基本信息",
      lines: [
        `- 路径：\`${workspace.path}\``,
        `- 活跃主仓库：${activeRepoLine}`,
        `- 创建时间：${_formatTs(workspace.created_at)}`,
        `- 上次活跃：${_formatTs(workspace.last_active_at)} (${_formatRelative(workspace.last_active_at)})`,
      ],
    }),
    ...buildSectionBlock({
      title: `仓库与分支 (${repos.length})`,
      lines:
        repos.length === 0
          ? ["- (当前 workspace 下还没有任何仓库)"]
          : repos.map((r) => {
              const ref = formatRepoRef(r.name, r.branch ?? "(游离)");
              return `- \`${ref}\`${r.is_active ? "  ← 活跃" : ""}`;
            }),
    }),
    ...buildSectionBlock({
      title: `绑定的群 (${bindings.length})`,
      lines:
        bindings.length === 0
          ? ["- (没有群绑定到此 workspace)"]
          : bindings.map((b) => `- \`${b.chat_id}\``),
    }),
    _buildDetailActionRow(workspace.id, is_protected),
  ];

  return {
    schema: "2.0",
    config: {
      streaming_mode: false,
      update_multi: true,
      width_mode: "fill",
      summary: { content: `🗂️ ${workspace.name}` },
    },
    body: {
      padding: "12px 16px 16px 16px",
      vertical_spacing: "12px",
      elements,
    },
  };
}

/**
 * Red two-button confirm card shown before anything is actually removed.
 * The apply button is the only path that triggers cascading deletion.
 */
export interface WorkspaceDeleteConfirmCardOptions {
  workspace: Workspace;
  binding_count: number;
  estimated_session_count: number;
}

export function buildWorkspaceDeleteConfirmCard(
  options: WorkspaceDeleteConfirmCardOptions,
): Card {
  const { workspace, binding_count, estimated_session_count } = options;
  const elements: Element[] = [
    buildCardIntro({
      title: "⚠️  确认删除 Workspace",
      subtitle: workspace.name,
    }),
    buildMarkdown(
      [
        "此操作不可撤销，会执行以下清理：",
        `- 解绑 **${binding_count}** 个群`,
        `- 级联删除约 **${estimated_session_count}** 个关联 session 及其 task 记录`,
        `- 移除物理目录 \`${workspace.path}\``,
        "- 保留 `git-cache/`（其他 workspace 仍可复用）",
      ].join("\n"),
    ),
    _buildDeleteConfirmRow(workspace.id),
  ];

  return {
    schema: "2.0",
    config: {
      streaming_mode: false,
      update_multi: true,
      width_mode: "fill",
      summary: { content: `⚠️ 确认删除 ${workspace.name}` },
    },
    body: {
      padding: "12px 16px 16px 16px",
      vertical_spacing: "12px",
      elements,
    },
  };
}

/**
 * Terminal result card reused by every setting flow (save / delete). Thin
 * wrapper over the shared `buildResultCard` so we can tweak the title in
 * one place if needed later.
 */
export function buildSettingResultCard(
  summary: string,
  detail: string[] = [],
): Card {
  return buildResultCard({
    title: "设置面板",
    summary,
    detail,
  });
}

function _buildConfigForm(options: SettingMainCardOptions): FormElement {
  const agentSelect: SelectStaticElement = {
    tag: "select_static",
    name: SETTING_FIELD.agentType,
    placeholder: { tag: "plain_text", content: "选择默认 Agent" },
    initial_option: options.agent.available_types.includes(
      options.agent.active_type,
    )
      ? options.agent.active_type
      : options.agent.available_types[0],
    options: options.agent.available_types.map((t) => ({
      text: { tag: "plain_text", content: t },
      value: t,
    })),
    width: "fill",
  };

  const modelInput: InputElement = {
    tag: "input",
    name: SETTING_FIELD.agentModel,
    placeholder: {
      tag: "plain_text",
      content: "留空表示让 runner 自选（如 Claude Code 默认）",
    },
    default_value: options.config_values.agent_model,
    width: "fill",
  };

  const codexChecker: CheckerElement = {
    tag: "checker",
    name: SETTING_FIELD.codexIsolateHostEnv,
    text: {
      tag: "plain_text",
      content: "Codex 环境隔离（指向独立 CODEX_HOME）",
    },
    checked: options.config_values.codex_isolate_host_env,
  };

  const retriesInput: InputElement = {
    tag: "input",
    name: SETTING_FIELD.maxRetries,
    placeholder: { tag: "plain_text", content: "正整数，如 3" },
    default_value: String(options.config_values.max_retries),
    width: "fill",
  };

  const submitBtn: ButtonElement = {
    tag: "button",
    name: SETTING_ACTION.saveConfig,
    text: { tag: "plain_text", content: "保存配置" },
    type: "primary",
    action_type: "form_submit",
    width: "fill",
  };

  return {
    tag: "form",
    name: "setting_config_form",
    elements: [
      buildMarkdown("**全局配置**"),
      buildMarkdown("<font color='grey'>默认 Agent</font>", {
        text_size: "notation",
      }),
      agentSelect,
      buildMarkdown("<font color='grey'>Agent Model</font>", {
        text_size: "notation",
      }),
      modelInput,
      buildMarkdown("<font color='grey'>Codex 行为</font>", {
        text_size: "notation",
      }),
      codexChecker,
      buildMarkdown("<font color='grey'>任务重试上限</font>", {
        text_size: "notation",
      }),
      retriesInput,
      submitBtn,
    ],
  };
}

function _buildWorkspaceRow(entry: {
  workspace: Workspace;
  binding_count: number;
  is_current: boolean;
}): Element {
  const { workspace, binding_count, is_current } = entry;
  const activeLine = workspace.active_repo
    ? `\`${formatRepoRef(workspace.active_repo, workspace.active_branch ?? "")}\``
    : "(未设置主仓库)";
  const marks: string[] = [];
  if (is_current) marks.push("当前群");
  if (binding_count > 0) marks.push(`${binding_count} 群绑定`);
  const summaryLine =
    `- **${workspace.name}** <font color='grey'>\`${workspace.id}\`</font>  ` +
    `${activeLine}  ·  活跃 ${_formatRelative(workspace.last_active_at)}` +
    (marks.length ? `  ·  <font color='blue'>${marks.join(" / ")}</font>` : "");

  const detailBtn: ButtonElement = {
    tag: "button",
    name: "setting_ws_detail_btn",
    text: { tag: "plain_text", content: "详情" },
    type: "default",
    behaviors: [
      {
        type: "callback",
        value: {
          action: SETTING_ACTION.wsDetail,
          workspace_id: workspace.id,
        },
      },
    ],
  };

  return {
    tag: "column_set",
    flex_mode: "stretch",
    horizontal_spacing: "12px",
    columns: [
      {
        tag: "column",
        width: "weighted",
        weight: 3,
        elements: [buildMarkdown(summaryLine)],
      },
      {
        tag: "column",
        width: "80px",
        elements: [detailBtn],
      },
    ],
  };
}

function _buildDetailActionRow(
  workspaceId: string,
  isProtected: boolean,
): Element {
  const backBtn: ButtonElement = {
    tag: "button",
    name: "setting_main_back_btn",
    text: { tag: "plain_text", content: "← 返回" },
    type: "default",
    width: "fill",
    behaviors: [
      {
        type: "callback",
        value: { action: SETTING_ACTION.mainBack },
      },
    ],
  };
  if (isProtected) {
    return {
      tag: "column_set",
      flex_mode: "stretch",
      horizontal_spacing: "12px",
      columns: [
        {
          tag: "column",
          width: "weighted",
          weight: 1,
          elements: [backBtn],
        },
      ],
    };
  }
  const deleteBtn: ButtonElement = {
    tag: "button",
    name: "setting_ws_delete_prompt_btn",
    text: { tag: "plain_text", content: "删除 Workspace" },
    type: "danger",
    width: "fill",
    behaviors: [
      {
        type: "callback",
        value: {
          action: SETTING_ACTION.wsDeletePrompt,
          workspace_id: workspaceId,
        },
      },
    ],
  };
  return {
    tag: "column_set",
    flex_mode: "stretch",
    horizontal_spacing: "12px",
    columns: [
      { tag: "column", width: "weighted", weight: 1, elements: [backBtn] },
      { tag: "column", width: "weighted", weight: 1, elements: [deleteBtn] },
    ],
  };
}

function _buildDeleteConfirmRow(workspaceId: string): Element {
  const cancelBtn: ButtonElement = {
    tag: "button",
    name: "setting_delete_cancel_btn",
    text: { tag: "plain_text", content: "取消" },
    type: "default",
    width: "fill",
    behaviors: [
      {
        type: "callback",
        value: {
          action: SETTING_ACTION.wsDetail,
          workspace_id: workspaceId,
        },
      },
    ],
  };
  const confirmBtn: ButtonElement = {
    tag: "button",
    name: "setting_delete_apply_btn",
    text: { tag: "plain_text", content: "确认删除" },
    type: "danger",
    width: "fill",
    behaviors: [
      {
        type: "callback",
        value: {
          action: SETTING_ACTION.wsDeleteApply,
          workspace_id: workspaceId,
        },
      },
    ],
  };
  return {
    tag: "column_set",
    flex_mode: "stretch",
    horizontal_spacing: "12px",
    columns: [
      { tag: "column", width: "weighted", weight: 1, elements: [cancelBtn] },
      { tag: "column", width: "weighted", weight: 1, elements: [confirmBtn] },
    ],
  };
}

function _formatTs(ms: number): string {
  if (!ms) return "(未知)";
  return dayjs(ms).format("YYYY-MM-DD HH:mm");
}

function _formatRelative(ms: number): string {
  if (!ms) return "未知";
  const diff = Date.now() - ms;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 30 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  return dayjs(ms).format("YYYY-MM-DD");
}
