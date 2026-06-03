import type { PredefinedRepo } from "@/shared";

import type {
  ButtonElement,
  Card,
  ColumnSetElement,
  Element,
  FormElement,
  InputElement,
} from "../../community/feishu/messaging/types";
import {
  buildCardIntro,
  buildDismissedCard,
  buildMarkdown,
  buildResultCard,
  buildSectionBlock,
} from "../setup/card-ui";

/**
 * Action discriminators for `/repos`. Kernel forwards any card action whose
 * name starts with `repos_` to `ReposFlow.handleAction`.
 */
export const REPOS_ACTION = {
  openAdd: "repos_open_add",
  openEdit: "repos_open_edit",
  openDelete: "repos_open_delete",
  addSubmit: "repos_add_submit",
  editSubmit: "repos_edit_submit",
  deleteApply: "repos_delete_apply",
  back: "repos_back",
  dismiss: "repos_dismiss",
} as const;

/**
 * Form field names for the add/edit forms. The two forms share input names
 * so the submit handler can treat them uniformly — the discriminator is the
 * button name (`addSubmit` vs `editSubmit`).
 */
export const REPOS_FIELD = {
  name: "repo_name",
  gitUrl: "repo_git_url",
  description: "repo_description",
} as const;

export interface ReposMainCardOptions {
  repos: PredefinedRepo[];
  /** Path string surfaced in the subtitle so users know where the file lives. */
  file_path: string;
}

/**
 * Top-level `/repos` panel: lists every repo currently in `REPOS.md` with
 * inline edit/delete buttons plus a "添加仓库" button at the bottom.
 */
export function buildReposMainCard(options: ReposMainCardOptions): Card {
  const { repos, file_path } = options;
  const elements: Element[] = [
    buildCardIntro({
      title: "REPOS.md 仓库管理",
      subtitle: `${file_path} · ${repos.length} 个仓库`,
    }),
  ];

  if (repos.length === 0) {
    elements.push(
      buildMarkdown(
        "<font color='grey'>REPOS.md 里还没有任何仓库条目。点击下方「添加仓库」新增一个。</font>",
      ),
    );
  } else {
    for (const repo of repos) {
      elements.push(_buildRepoRow(repo));
    }
  }

  elements.push(_buildMainActionRow());

  return {
    schema: "2.0",
    config: {
      streaming_mode: false,
      update_multi: true,
      width_mode: "fill",
      summary: { content: "📚 REPOS.md 管理" },
    },
    body: {
      padding: "12px 16px 16px 16px",
      vertical_spacing: "12px",
      elements,
    },
  };
}

export interface ReposFormCardOptions {
  /**
   * Edit mode pre-fills the form with the current values and disables the
   * `name` input (rename = delete + add). Add mode renders an empty form
   * with the name input enabled.
   */
  mode: "add" | "edit";
  initial?: PredefinedRepo;
}

/**
 * Add / edit form card. Both modes share the same input layout — the
 * submit button is the only thing that changes, so the handler can route
 * on its name (`addSubmit` vs `editSubmit`).
 */
export function buildReposFormCard(options: ReposFormCardOptions): Card {
  const { mode, initial } = options;
  const title = mode === "add" ? "添加仓库" : `编辑仓库 ${initial?.name ?? ""}`;

  const nameInput: InputElement = {
    tag: "input",
    name: REPOS_FIELD.name,
    placeholder: { tag: "plain_text", content: "例如 agentara" },
    default_value: initial?.name,
    width: "fill",
  };
  const gitUrlInput: InputElement = {
    tag: "input",
    name: REPOS_FIELD.gitUrl,
    placeholder: { tag: "plain_text", content: "git@... 或 https://..." },
    default_value: initial?.git_url,
    width: "fill",
  };
  const descInput: InputElement = {
    tag: "input",
    name: REPOS_FIELD.description,
    placeholder: { tag: "plain_text", content: "一句话描述（可选）" },
    default_value: initial?.description,
    width: "fill",
  };

  const submitBtn: ButtonElement = {
    tag: "button",
    name:
      mode === "add"
        ? REPOS_ACTION.addSubmit
        : REPOS_ACTION.editSubmit,
    text: { tag: "plain_text", content: mode === "add" ? "保存" : "保存修改" },
    type: "primary",
    action_type: "form_submit",
    width: "fill",
  };

  const formElements: Element[] = [
    buildMarkdown("**名称**"),
  ];
  if (mode === "edit") {
    // Renaming = delete + add, which would orphan any prose context inside
    // the section. Surface the name as static text in edit mode to make
    // that constraint obvious instead of pretending it's editable.
    formElements.push(
      buildMarkdown(`\`${initial?.name ?? ""}\``),
      buildMarkdown(
        "<font color='grey'>编辑模式下名称不可改；改名请先删除再添加。</font>",
        { text_size: "notation" },
      ),
    );
  } else {
    formElements.push(nameInput);
  }
  formElements.push(
    buildMarkdown("**git_url**"),
    gitUrlInput,
    buildMarkdown("**描述（可选）**"),
    descInput,
    submitBtn,
  );

  const form: FormElement = {
    tag: "form",
    name: mode === "add" ? "repos_add_form" : "repos_edit_form",
    elements: formElements,
  };

  return {
    schema: "2.0",
    config: {
      streaming_mode: false,
      update_multi: true,
      width_mode: "fill",
      summary: { content: `📚 ${title}` },
    },
    body: {
      padding: "12px 16px 16px 16px",
      vertical_spacing: "12px",
      elements: [
        buildCardIntro({ title }),
        form,
        _buildBackDismissRow(),
      ],
    },
  };
}

export interface ReposDeleteConfirmCardOptions {
  repo: PredefinedRepo;
}

export function buildReposDeleteConfirmCard(
  options: ReposDeleteConfirmCardOptions,
): Card {
  const { repo } = options;
  return {
    schema: "2.0",
    config: {
      streaming_mode: false,
      update_multi: true,
      width_mode: "fill",
      summary: { content: `⚠️ 删除 ${repo.name}` },
    },
    body: {
      padding: "12px 16px 16px 16px",
      vertical_spacing: "12px",
      elements: [
        buildCardIntro({
          title: "⚠️  确认删除仓库条目",
          subtitle: repo.name,
        }),
        ...buildSectionBlock({
          title: "将从 REPOS.md 移除",
          lines: [
            `- 名称：\`${repo.name}\``,
            `- git_url：\`${repo.git_url}\``,
            repo.description
              ? `- 描述：${repo.description}`
              : "- 描述：(未填)",
            "- 已克隆的本地仓库不受影响。",
          ],
        }),
        _buildDeleteConfirmRow(repo.name),
      ],
    },
  };
}

export function buildReposResultCard(
  summary: string,
  detail: string[] = [],
): Card {
  const card = buildResultCard({
    title: "REPOS.md",
    summary,
    detail,
  });
  card.body.elements.push(_buildBackDismissRow());
  return card;
}

export function buildReposDismissedCard(): Card {
  return buildDismissedCard({ title: "REPOS.md 仓库管理" });
}

function _buildRepoRow(repo: PredefinedRepo): ColumnSetElement {
  const desc = repo.description?.trim();
  const lines = [
    `**${repo.name}**`,
    `\`${repo.git_url}\``,
  ];
  if (desc) lines.push(`<font color='grey'>${desc}</font>`);

  const editBtn: ButtonElement = {
    tag: "button",
    name: `repos_edit_btn_${repo.name}`,
    text: { tag: "plain_text", content: "编辑" },
    type: "default",
    width: "fill",
    behaviors: [
      {
        type: "callback",
        value: { action: REPOS_ACTION.openEdit, repo_name: repo.name },
      },
    ],
  };
  const deleteBtn: ButtonElement = {
    tag: "button",
    name: `repos_delete_btn_${repo.name}`,
    text: { tag: "plain_text", content: "删除" },
    type: "danger",
    width: "fill",
    behaviors: [
      {
        type: "callback",
        value: { action: REPOS_ACTION.openDelete, repo_name: repo.name },
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
        vertical_align: "center",
        elements: [buildMarkdown(lines.join("\n"))],
      },
      {
        tag: "column",
        width: "170px",
        vertical_align: "center",
        elements: [
          {
            tag: "column_set",
            flex_mode: "stretch",
            horizontal_spacing: "4px",
            columns: [
              { tag: "column", width: "weighted", weight: 1, elements: [editBtn] },
              { tag: "column", width: "weighted", weight: 1, elements: [deleteBtn] },
            ],
          },
        ],
      },
    ],
  };
}

function _buildMainActionRow(): ColumnSetElement {
  const addBtn: ButtonElement = {
    tag: "button",
    name: "repos_open_add_btn",
    text: { tag: "plain_text", content: "添加仓库" },
    type: "primary",
    width: "fill",
    behaviors: [
      { type: "callback", value: { action: REPOS_ACTION.openAdd } },
    ],
  };
  return {
    tag: "column_set",
    flex_mode: "stretch",
    horizontal_spacing: "12px",
    columns: [
      { tag: "column", width: "weighted", weight: 1, elements: [addBtn] },
      {
        tag: "column",
        width: "weighted",
        weight: 1,
        elements: [_buildDismissButton()],
      },
    ],
  };
}

function _buildBackDismissRow(): ColumnSetElement {
  const backBtn: ButtonElement = {
    tag: "button",
    name: "repos_back_btn",
    text: { tag: "plain_text", content: "← 返回" },
    type: "default",
    width: "fill",
    behaviors: [
      { type: "callback", value: { action: REPOS_ACTION.back } },
    ],
  };
  return {
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
  };
}

function _buildDeleteConfirmRow(repoName: string): ColumnSetElement {
  const cancelBtn: ButtonElement = {
    tag: "button",
    name: "repos_delete_cancel_btn",
    text: { tag: "plain_text", content: "← 返回" },
    type: "default",
    width: "fill",
    behaviors: [
      { type: "callback", value: { action: REPOS_ACTION.back } },
    ],
  };
  const confirmBtn: ButtonElement = {
    tag: "button",
    name: "repos_delete_apply_btn",
    text: { tag: "plain_text", content: "确认删除" },
    type: "danger",
    width: "fill",
    behaviors: [
      {
        type: "callback",
        value: { action: REPOS_ACTION.deleteApply, repo_name: repoName },
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

function _buildDismissButton(): ButtonElement {
  return {
    tag: "button",
    name: "repos_dismiss_btn",
    text: { tag: "plain_text", content: "关闭" },
    type: "default",
    width: "fill",
    behaviors: [
      { type: "callback", value: { action: REPOS_ACTION.dismiss } },
    ],
  };
}
