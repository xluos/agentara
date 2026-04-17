import type { PredefinedRepo } from "@/shared";

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
  buildMarkdown,
  buildResultCard,
  buildSectionPanel,
} from "./card-ui";

/**
 * Field naming convention used by both the card renderer and the submit
 * handler. Keep them in one place so the two sides cannot drift apart.
 */
export const SETUP_FIELD = {
  workspaceName: "workspace_name",
  repoChecker: (name: string) => `repo_${name}`,
  branchInput: (name: string) => `branch_${name}`,
  primaryRepo: "primary_repo",
} as const;

/**
 * Per-repo pre-fill state for re-runs of `/setup`. When a repo is already
 * cloned in the workspace we surface it on the card as `checked: true` +
 * `disabled: true` so the user cannot uncheck it, and pre-fill the branch
 * input with the repo's current HEAD so editing = branch switch on submit.
 */
export interface RepoPrefill {
  /** Repo is already cloned → checker is forced on and disabled. */
  already_cloned: boolean;
  /** Branch to pre-fill in the input (current HEAD for existing repos). */
  current_branch?: string;
}

export interface SetupCardOptions {
  /** Keyed by repo name. Missing entries render as unchecked + editable. */
  prefills?: Record<string, RepoPrefill>;
  /** Primary repo to preselect in the bottom dropdown (usually current active_repo). */
  primary_repo?: string;
  /**
   * Pre-fill + lock state for the workspace-name input.
   * - First run: `value` is the suggested default (editable); no `id` yet.
   * - Re-run: `value` is the current workspace directory name, `locked: true`,
   *   `id` is the stable workspace id shown alongside so the user can copy
   *   it out and `/bind <id>` from another group.
   */
  workspace_name?: { value: string; locked: boolean; id?: string };
}

/**
 * Build the interactive `/setup` card.
 *
 * Compared with the original plain-markdown card, this version adds:
 * - a proper card head so the action is recognizable in chat history
 * - a collapsible "how it works" section
 * - a current-state summary when editing an existing workspace
 * - clearer per-repo rows (name/description/status separated from branch input)
 */
export function buildSetupCard(
  catalog: PredefinedRepo[],
  options: SetupCardOptions = {},
): Card {
  const prefills = options.prefills ?? {};
  const hasExisting = Object.values(prefills).some((p) => p.already_cloned);
  const lockedRepos = catalog
    .filter((repo) => prefills[repo.name]?.already_cloned)
    .map((repo) => repo.name);

  const formElements: Element[] = [];

  if (options.workspace_name) {
    formElements.push(..._buildWorkspaceNameInput(options.workspace_name));
  }

  formElements.push(
    buildMarkdown("**仓库与分支**"),
  );

  for (const repo of catalog) {
    formElements.push(_buildRepoRow(repo, prefills[repo.name]));
  }

  formElements.push(
    buildMarkdown("**主仓库**"),
  );
  formElements.push(_buildPrimarySelect(catalog, options.primary_repo));
  formElements.push(_buildSubmitButton(hasExisting));

  const form: FormElement = {
    tag: "form",
    name: "setup_form",
    elements: formElements,
  };

  const bodyElements: Element[] = [
    buildCardIntro({
      title: hasExisting ? "更新 Workspace" : "初始化 Workspace",
    }),
  ];

  if (hasExisting) {
    const currentSummaryLines = [
      `- 已纳管仓库：${lockedRepos.map((name) => `\`${name}\``).join("、") || "（暂无）"}`,
      `- 当前主仓库：\`${options.primary_repo ?? "（未设置）"}\``,
    ];
    if (options.workspace_name?.id) {
      currentSummaryLines.push(`- Workspace ID：\`${options.workspace_name.id}\``);
    }
    bodyElements.push(
      buildSectionPanel({
        title: "当前状态",
        expanded: true,
        tone: "neutral",
        elements: [buildMarkdown(currentSummaryLines.join("\n"))],
      }),
    );
  }

  bodyElements.push(form);

  return {
    schema: "2.0",
    config: {
      streaming_mode: false,
      update_multi: true,
      width_mode: "fill",
      summary: {
        content: hasExisting ? "📦 更新 workspace" : "📦 初始化 workspace",
      },
    },
    body: {
      padding: "12px 16px 16px 16px",
      vertical_spacing: "12px",
      elements: bodyElements,
    },
  };
}

function _buildWorkspaceNameInput(
  state: NonNullable<SetupCardOptions["workspace_name"]>,
): Element[] {
  const input: InputElement = {
    tag: "input",
    name: SETUP_FIELD.workspaceName,
    placeholder: { tag: "plain_text", content: "workspace 名称" },
    default_value: state.value,
    width: "fill",
  };

  const elements: Element[] = [
    buildMarkdown("**Workspace 名称**"),
    input,
  ];

  if (state.id) {
    elements.push(
      buildMarkdown(`<font color='grey'>当前 Workspace ID：\`${state.id}\`</font>`, {
        text_size: "notation",
      }),
    );
  }

  return elements;
}

function _buildRepoRow(
  repo: PredefinedRepo,
  prefill?: RepoPrefill,
): ColumnSetElement {
  const alreadyCloned = prefill?.already_cloned === true;
  const checker: CheckerElement = {
    tag: "checker",
    name: SETUP_FIELD.repoChecker(repo.name),
    text: { tag: "plain_text", content: repo.name },
    checked: alreadyCloned,
    disabled: alreadyCloned,
  };
  const branchInput: InputElement = {
    tag: "input",
    name: SETUP_FIELD.branchInput(repo.name),
    placeholder: { tag: "plain_text", content: "master" },
    default_value: prefill?.current_branch,
    width: "fill",
  };

  return {
    tag: "column_set",
    flex_mode: "stretch",
    horizontal_spacing: "12px",
    columns: [
      {
        tag: "column",
        width: "weighted",
        weight: 1,
        elements: [
          checker,
          ...(repo.description
            ? [
                buildMarkdown(
                  `<font color='grey'>${repo.description}</font>`,
                  { text_size: "notation" },
                ),
              ]
            : []),
          ...(alreadyCloned
            ? [
                buildMarkdown(
                  "<font color='green'>已存在于当前 workspace，可直接修改分支。</font>",
                  { text_size: "notation" },
                ),
              ]
            : []),
        ],
      },
      {
        tag: "column",
        width: "160px",
        elements: [
          buildMarkdown("<font color='grey'>分支</font>", { text_size: "notation" }),
          branchInput,
        ],
      },
    ],
  };
}

function _buildPrimarySelect(
  catalog: PredefinedRepo[],
  preselected?: string,
): SelectStaticElement {
  const initial =
    preselected && catalog.some((r) => r.name === preselected)
      ? preselected
      : catalog[0]?.name;
  return {
    tag: "select_static",
    name: SETUP_FIELD.primaryRepo,
    placeholder: { tag: "plain_text", content: "选择主仓库（默认第一个）" },
    initial_option: initial,
    options: catalog.map((r) => ({
      text: { tag: "plain_text", content: r.name },
      value: r.name,
    })),
    width: "fill",
  };
}

function _buildSubmitButton(hasExisting: boolean): ButtonElement {
  return {
    tag: "button",
    name: "setup_submit",
    text: {
      tag: "plain_text",
      content: hasExisting ? "保存并更新" : "开始初始化",
    },
    type: "primary",
    action_type: "form_submit",
    width: "fill",
  };
}

/**
 * Result card rendered after the submit handler finishes. Replaces the
 * original card in place via `updateRawCard`.
 */
export function buildSetupResultCard(
  summary: string,
  perRepoLines: string[],
): Card {
  return buildResultCard({
    title: "Workspace 处理结果",
    summary,
    detail: perRepoLines,
  });
}
