import dayjs from "dayjs";

import { formatRepoRef } from "@/kernel/repo-ref";
import type { GroupWorkspace, Workspace } from "@/shared";

import type {
  ButtonElement,
  Card,
  CheckerElement,
  ColumnSetElement,
  Element,
  FormElement,
  InputElement,
  SelectStaticElement,
} from "../../community/feishu/messaging/types";
import {
  buildCardIntro,
  buildDismissedCard,
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
  dismiss: "setting_dismiss",
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
    /** `_default` and similar reserved paths skip the delete button. */
    is_protected: boolean;
    /**
     * Live branch name the workspace's active repo is currently on (from the
     * on-disk HEAD). `null` when there's no active_repo or HEAD is detached.
     * Resolved by the flow so the card never displays the stale stored
     * `active_branch` hint.
     */
    active_branch_head: string | null;
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

  elements.push(_buildDismissButton());

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
  /** Live HEAD of the active repo; matches the per-repo row below. */
  active_branch_head: string | null;
}

export function buildWorkspaceDetailCard(
  options: WorkspaceDetailCardOptions,
): Card {
  const { workspace, bindings, repos, is_protected, active_branch_head } = options;
  const activeRepoLine = workspace.active_repo
    ? `\`${formatRepoRef(workspace.active_repo, active_branch_head ?? "(游离)")}\``
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
 * Terminal result card reused by every setting flow (save / delete / error).
 * Always appends a "返回设置面板" button so the user can re-enter the panel
 * without having to re-send the slash command. Disable via `show_back: false`
 * for transient fail states that shouldn't offer re-entry.
 */
export function buildSettingResultCard(
  summary: string,
  detail: string[] = [],
  options: { show_back?: boolean } = {},
): Card {
  const card = buildResultCard({
    title: "设置面板",
    summary,
    detail,
  });
  if (options.show_back ?? true) {
    const backBtn: ButtonElement = {
      tag: "button",
      name: "setting_result_back_btn",
      text: { tag: "plain_text", content: "返回设置面板" },
      type: "default",
      width: "fill",
      behaviors: [
        {
          type: "callback",
          value: { action: SETTING_ACTION.mainBack },
        },
      ],
    };
    card.body.elements.push({
      tag: "column_set",
      flex_mode: "stretch",
      horizontal_spacing: "12px",
      columns: [
        { tag: "column", width: "weighted", weight: 1, elements: [backBtn] },
        {
          tag: "column",
          width: "weighted",
          weight: 1,
          elements: [_buildDismissButton()],
        },
      ],
    });
  }
  return card;
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

  // Agent type is the primary choice (wider); Agent Model is rarely tweaked
  // once set, so it gets a narrower column.
  const agentRow: ColumnSetElement = {
    tag: "column_set",
    flex_mode: "stretch",
    horizontal_spacing: "12px",
    columns: [
      {
        tag: "column",
        width: "weighted",
        weight: 2,
        vertical_spacing: "4px",
        elements: [
          buildMarkdown("<font color='grey'>默认 Agent</font>", {
            text_size: "notation",
          }),
          agentSelect,
        ],
      },
      {
        tag: "column",
        width: "weighted",
        weight: 1,
        vertical_spacing: "4px",
        elements: [
          buildMarkdown("<font color='grey'>Agent Model</font>", {
            text_size: "notation",
          }),
          modelInput,
        ],
      },
    ],
  };

  return {
    tag: "form",
    name: "setting_config_form",
    elements: [
      buildMarkdown("**全局配置**"),
      agentRow,
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
  is_protected: boolean;
  active_branch_head: string | null;
}): Element {
  const { workspace, binding_count, is_current, is_protected, active_branch_head } = entry;

  // Primary line: workspace name in bold. The stable id moves to the meta
  // line so the title stays short and scannable.
  const titleEl = buildMarkdown(`**${workspace.name}**`);

  // Secondary line: currently active repo/branch — the single most
  // operationally relevant fact for each row. Branch comes from the on-disk
  // HEAD (passed in as `active_branch_head`), matching `/status`: the stored
  // `active_branch` is only a hint and drifts after the user `checkout`s.
  const activeEl = buildMarkdown(
    workspace.active_repo
      ? `\`${formatRepoRef(workspace.active_repo, active_branch_head ?? "(游离)")}\``
      : "<font color='grey'>未设置主仓库</font>",
    { text_size: "notation" },
  );

  // Meta line: id + last-active badge + (optional) binding count + current
  // chat tag. The active badge changes color by age so dormant workspaces
  // are visually obvious without the user having to eyeball timestamps.
  const activeBadge = _formatActiveBadge(workspace.last_active_at);
  const metaParts: string[] = [
    `<font color='grey'>ID \`${workspace.id}\`</font>`,
    `<font color='${activeBadge.color}'>${activeBadge.text}</font>`,
  ];
  if (binding_count > 0) {
    metaParts.push(`<font color='grey'>${binding_count} 群绑定</font>`);
  }
  if (is_current) {
    metaParts.push("<font color='green'>**当前群**</font>");
  }
  const metaEl = buildMarkdown(metaParts.join(" · "), { text_size: "notation" });

  const detailBtn: ButtonElement = {
    tag: "button",
    name: `setting_ws_detail_btn_${workspace.id}`,
    text: { tag: "plain_text", content: "详情" },
    type: "default",
    width: "fill",
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
  const deleteBtn: ButtonElement = {
    tag: "button",
    name: `setting_ws_delete_btn_${workspace.id}`,
    text: { tag: "plain_text", content: "删除" },
    type: "danger",
    width: "fill",
    behaviors: [
      {
        type: "callback",
        value: {
          action: SETTING_ACTION.wsDeletePrompt,
          workspace_id: workspace.id,
        },
      },
    ],
  };

  // Buttons sit in a narrow right-hand column; nesting a tight column_set
  // inside it keeps the two buttons visually adjacent (no big gap) while
  // still letting the left column stretch to take all remaining width.
  const buttonStack: ColumnSetElement = {
    tag: "column_set",
    flex_mode: "stretch",
    horizontal_spacing: "4px",
    columns: is_protected
      ? [{ tag: "column", width: "weighted", weight: 1, elements: [detailBtn] }]
      : [
          { tag: "column", width: "weighted", weight: 1, elements: [detailBtn] },
          { tag: "column", width: "weighted", weight: 1, elements: [deleteBtn] },
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
        vertical_spacing: "4px",
        vertical_align: "center",
        elements: [titleEl, activeEl, metaEl],
      },
      {
        tag: "column",
        width: is_protected ? "90px" : "170px",
        vertical_align: "center",
        elements: [buttonStack],
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
  const dismissBtn = _buildDismissButton();
  if (isProtected) {
    return {
      tag: "column_set",
      flex_mode: "stretch",
      horizontal_spacing: "12px",
      columns: [
        { tag: "column", width: "weighted", weight: 1, elements: [backBtn] },
        { tag: "column", width: "weighted", weight: 1, elements: [dismissBtn] },
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
      { tag: "column", width: "weighted", weight: 1, elements: [dismissBtn] },
      { tag: "column", width: "weighted", weight: 1, elements: [deleteBtn] },
    ],
  };
}

function _buildDismissButton(): ButtonElement {
  return {
    tag: "button",
    name: "setting_dismiss_btn",
    text: { tag: "plain_text", content: "关闭" },
    type: "default",
    width: "fill",
    behaviors: [
      {
        type: "callback",
        value: { action: SETTING_ACTION.dismiss },
      },
    ],
  };
}

/**
 * Dismiss card swapped in when the user clicks "关闭" on any setting card.
 * Same neutral shape as `buildSettingResultCard` but with no buttons —
 * leaving the panel cleanly closed.
 */
export function buildSettingDismissedCard(): Card {
  return buildDismissedCard({ title: "设置面板" });
}

function _buildDeleteConfirmRow(workspaceId: string): Element {
  const cancelBtn: ButtonElement = {
    tag: "button",
    name: "setting_delete_cancel_btn",
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
      {
        tag: "column",
        width: "weighted",
        weight: 1,
        elements: [_buildDismissButton()],
      },
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

const DAY_MS = 86_400_000;

/**
 * Color-coded freshness label for a workspace's `last_active_at`.
 *
 * - ≤ 3 days → green "活跃 …" — recently used, safe.
 * - ≤ 30 days → grey "活跃 …" — cold but not abandoned.
 * - > 30 days → red "超过 N 个月未活跃" — explicit warning to consider pruning.
 */
function _formatActiveBadge(ms: number): { text: string; color: string } {
  if (!ms) return { text: "活跃未知", color: "grey" };
  const diff = Date.now() - ms;
  if (diff < 3 * DAY_MS) {
    return { text: `活跃 ${_formatRelative(ms)}`, color: "green" };
  }
  if (diff < 30 * DAY_MS) {
    return { text: `活跃 ${_formatRelative(ms)}`, color: "grey" };
  }
  const months = Math.max(1, Math.floor(diff / (30 * DAY_MS)));
  return { text: `超过 ${months} 个月未活跃`, color: "red" };
}
