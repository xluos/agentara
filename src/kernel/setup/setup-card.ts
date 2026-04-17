import type { PredefinedRepo } from "@/shared";

import type {
  ButtonElement,
  Card,
  CheckerElement,
  ColumnSetElement,
  Element,
  FormElement,
  InputElement,
  MarkdownElement,
  SelectStaticElement,
} from "../../community/feishu/messaging/types";

/**
 * Field naming convention used by both the card renderer and the submit
 * handler. Keep them in one place so the two sides cannot drift apart.
 */
export const SETUP_FIELD = {
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
}

/**
 * Build the interactive `/setup` card.
 *
 * Layout:
 * - Header: prompt text
 * - Form body: one row per predefined repo (checker + branch input + description)
 * - Primary-repo selector (always shown; default = first repo in catalog)
 * - Submit button ("初始化") with `action_type: "form_submit"`. On submit the
 *   server receives `action.name = "setup_submit"` and `action.form_value`
 *   carries the checker + input + select values.
 *
 * Re-runs pass `options.prefills` so already-cloned repos render as
 * locked-on checkers with their current branch pre-filled; new catalog
 * entries render as unchecked and can be picked to be added.
 *
 * Card-to-pending correlation happens on the kernel side via `message_id`,
 * so the card itself carries no setup_id.
 */
export function buildSetupCard(
  catalog: PredefinedRepo[],
  options: SetupCardOptions = {},
): Card {
  const formElements: Element[] = [];
  const prefills = options.prefills ?? {};
  const hasExisting = Object.values(prefills).some((p) => p.already_cloned);

  for (const repo of catalog) {
    formElements.push(_buildRepoRow(repo, prefills[repo.name]));
  }

  formElements.push(_buildPrimarySelect(catalog, options.primary_repo));
  formElements.push(_buildSubmitButton());

  const form: FormElement = {
    tag: "form",
    name: "setup_form",
    elements: formElements,
  };

  const headerLines = hasExisting
    ? [
        "**📦 更新当前群的 workspace**",
        "",
        "已绑定的仓库保持勾选（不可取消）。可以修改其分支，或勾选新仓库加入。",
        "底部「主仓库」可切换后续消息默认使用的仓库。",
      ]
    : [
        "**📦 初始化当前群的 workspace**",
        "",
        "勾选要克隆的仓库；分支默认 `master`，留空即使用 master。",
        "选多个仓库时，请在底部选一个作为「主仓库」（后续消息的默认仓库）。",
      ];
  const header: MarkdownElement = {
    tag: "markdown",
    content: headerLines.join("\n"),
  };

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
      elements: [header, form],
    },
  };
}

function _buildRepoRow(
  repo: PredefinedRepo,
  prefill?: RepoPrefill,
): ColumnSetElement {
  // NOTE: Feishu's checker.text ONLY accepts `plain_text`, not `markdown`.
  // Attempting markdown yields "type of element is not supported tag: markdown"
  // (error 200621). We inline the description into the label as a plain string.
  const label = repo.description
    ? `${repo.name} — ${repo.description}`
    : repo.name;
  const alreadyCloned = prefill?.already_cloned === true;
  const checker: CheckerElement = {
    tag: "checker",
    name: SETUP_FIELD.repoChecker(repo.name),
    text: { tag: "plain_text", content: label },
    checked: alreadyCloned,
    // Already-cloned repos are locked on so the user can't accidentally drop
    // an existing binding. New catalog entries stay fully editable.
    disabled: alreadyCloned,
  };
  const branchInput: InputElement = {
    tag: "input",
    name: SETUP_FIELD.branchInput(repo.name),
    placeholder: { tag: "plain_text", content: "master" },
    // Pre-fill with the repo's current branch so editing this field = switch.
    default_value: prefill?.current_branch,
    width: "fill",
  };

  return {
    tag: "column_set",
    flex_mode: "stretch",
    horizontal_spacing: "8px",
    columns: [
      { tag: "column", width: "weighted", weight: 1, elements: [checker] },
      { tag: "column", width: "140px", elements: [branchInput] },
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

function _buildSubmitButton(): ButtonElement {
  // IMPORTANT: use `action_type: "form_submit"` alone — do NOT combine with
  // `behaviors: [{ type: "callback", ... }]`. Feishu's validator requires at
  // least one recognizable submit button inside a form container, and a
  // `callback` behavior makes the button look like a plain callback button
  // instead, producing "there is no submit button in the form container".
  //
  // The setup flow correlates the submit event by `message_id` (we keep
  // pending state keyed by the card's message id), so the button does not
  // need to carry setup_id itself.
  return {
    tag: "button",
    name: "setup_submit",
    text: { tag: "plain_text", content: "✅ 初始化" },
    type: "primary",
    action_type: "form_submit",
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
  const elements: Element[] = [
    {
      tag: "markdown",
      content: summary,
    },
  ];
  if (perRepoLines.length > 0) {
    elements.push({
      tag: "markdown",
      content: perRepoLines.join("\n"),
    });
  }
  return {
    schema: "2.0",
    config: {
      streaming_mode: false,
      update_multi: true,
      width_mode: "fill",
      summary: { content: summary.slice(0, 80) },
    },
    body: { elements },
  };
}
