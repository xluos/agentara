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
export const INIT_FIELD = {
  repoChecker: (name: string) => `repo_${name}`,
  branchInput: (name: string) => `branch_${name}`,
  primaryRepo: "primary_repo",
} as const;

/**
 * Build the interactive `/init` card.
 *
 * Layout:
 * - Header: prompt text
 * - Form body: one row per predefined repo (checker + branch input + description)
 * - Primary-repo selector (always shown; default = first repo in catalog)
 * - Submit button ("初始化") with `action_type: "form_submit"`. On submit the
 *   server receives `action.name = "init_submit"` and `action.form_value`
 *   carries the checker + input + select values.
 *
 * Card-to-pending correlation happens on the kernel side via `message_id`,
 * so the card itself carries no init_id.
 */
export function buildInitCard(catalog: PredefinedRepo[]): Card {
  const formElements: Element[] = [];

  for (const repo of catalog) {
    formElements.push(_buildRepoRow(repo));
  }

  formElements.push(_buildPrimarySelect(catalog));
  formElements.push(_buildSubmitButton());

  const form: FormElement = {
    tag: "form",
    name: "init_form",
    elements: formElements,
  };

  const header: MarkdownElement = {
    tag: "markdown",
    content: [
      "**📦 初始化当前群的 workspace**",
      "",
      "勾选要克隆的仓库；分支默认 `master`，留空即使用 master。",
      "选多个仓库时，请在底部选一个作为「主仓库」（后续消息的默认仓库）。",
    ].join("\n"),
  };

  return {
    schema: "2.0",
    config: {
      streaming_mode: false,
      update_multi: true,
      width_mode: "fill",
      summary: { content: "📦 初始化 workspace" },
    },
    body: {
      elements: [header, form],
    },
  };
}

function _buildRepoRow(repo: PredefinedRepo): ColumnSetElement {
  // NOTE: Feishu's checker.text ONLY accepts `plain_text`, not `markdown`.
  // Attempting markdown yields "type of element is not supported tag: markdown"
  // (error 200621). We inline the description into the label as a plain string.
  const label = repo.description
    ? `${repo.name} — ${repo.description}`
    : repo.name;
  const checker: CheckerElement = {
    tag: "checker",
    name: INIT_FIELD.repoChecker(repo.name),
    text: { tag: "plain_text", content: label },
    checked: false,
  };
  const branchInput: InputElement = {
    tag: "input",
    name: INIT_FIELD.branchInput(repo.name),
    placeholder: { tag: "plain_text", content: "master" },
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

function _buildPrimarySelect(catalog: PredefinedRepo[]): SelectStaticElement {
  return {
    tag: "select_static",
    name: INIT_FIELD.primaryRepo,
    placeholder: { tag: "plain_text", content: "选择主仓库（默认第一个）" },
    initial_option: catalog[0]?.name,
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
  // The init flow correlates the submit event by `message_id` (we keep
  // pending state keyed by the card's message id), so the button does not
  // need to carry init_id itself.
  return {
    tag: "button",
    name: "init_submit",
    text: { tag: "plain_text", content: "✅ 初始化" },
    type: "primary",
    action_type: "form_submit",
  };
}

/**
 * Result card rendered after the submit handler finishes. Replaces the
 * original card in place via `updateRawCard`.
 */
export function buildInitResultCard(
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
