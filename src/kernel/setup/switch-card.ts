import type { Workspace } from "@/shared";

import type {
  ButtonElement,
  Card,
  Element,
  FormElement,
  MarkdownElement,
  SelectStaticElement,
} from "../../community/feishu/messaging/types";

/**
 * Shared field names used by both the card renderer and the submit handler.
 * Keep them in one place so the two sides cannot drift apart.
 */
export const SWITCH_FIELD = {
  workspaceId: "workspace_id",
} as const;

/**
 * Sentinel value emitted by the "detach" option. Not a real workspace id —
 * picking it clears the binding for the current chat and falls back to the
 * default workspace.
 */
export const SWITCH_DETACH_VALUE = "__detach__";

/**
 * Summary of the current binding, rendered above the selector so the user
 * can see what they're switching away from before picking.
 */
export interface CurrentBindingSummary {
  workspace_id: string;
  workspace_name: string;
  workspace_path: string;
  active_repo?: string | null;
  active_branch?: string | null;
}

export interface SwitchCardOptions {
  /** All known workspaces, sorted by caller. */
  workspaces: Workspace[];
  /** Current binding for this chat; preselects the dropdown + shows summary. */
  current?: CurrentBindingSummary;
}

/**
 * Build the `/switch` card.
 *
 * Layout:
 * - Header
 * - Current-binding summary (markdown) — omitted when chat has no binding
 * - Form body:
 *   - select_static with one option per workspace + a trailing "detach" option
 *   - Submit button ("切换")
 *
 * Pending correlation happens on the kernel side via `message_id`, so the
 * card carries no id of its own.
 */
export function buildSwitchCard(options: SwitchCardOptions): Card {
  const { workspaces, current } = options;

  const header: MarkdownElement = {
    tag: "markdown",
    content: [
      "**🔀 切换当前会话的 workspace**",
      "",
      "从下面的列表里挑一个已有 workspace；选「取消绑定」则回到默认 workspace。",
    ].join("\n"),
  };

  const body: Element[] = [header];

  if (current) {
    body.push({
      tag: "markdown",
      content: [
        "**当前绑定：**",
        `- 名称：\`${current.workspace_name}\``,
        `- ID：\`${current.workspace_id}\``,
        `- 活跃仓库：\`${current.active_repo ?? "(未设置)"}\``,
        `- 活跃分支：\`${current.active_branch ?? "(未设置)"}\``,
      ].join("\n"),
    });
  } else {
    body.push({
      tag: "markdown",
      content:
        "_当前会话还没有绑定任何 workspace，正在使用默认 workspace。_",
    });
  }

  const select = _buildWorkspaceSelect(workspaces, current?.workspace_id);
  const submit = _buildSubmitButton();
  const form: FormElement = {
    tag: "form",
    name: "switch_form",
    elements: [select, submit],
  };
  body.push(form);

  return {
    schema: "2.0",
    config: {
      streaming_mode: false,
      update_multi: true,
      width_mode: "fill",
      summary: { content: "🔀 切换 workspace" },
    },
    body: { elements: body },
  };
}

/**
 * Result card rendered after the submit handler finishes. Replaces the
 * original card in place via `updateRawCard`.
 */
export function buildSwitchResultCard(summary: string, detail: string[] = []): Card {
  const elements: Element[] = [
    { tag: "markdown", content: summary },
  ];
  if (detail.length > 0) {
    elements.push({ tag: "markdown", content: detail.join("\n") });
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

function _buildWorkspaceSelect(
  workspaces: Workspace[],
  preselected?: string,
): SelectStaticElement {
  // Feishu's select_static has no "empty" state — when there are no
  // workspaces we still render a single disabled-feeling placeholder option
  // so the card is valid. Callers should prefer to skip the card entirely in
  // that case, but we don't want the renderer to throw either way.
  const options = workspaces.map((ws) => ({
    text: {
      tag: "plain_text" as const,
      content: `${ws.name}  (${ws.id})`,
    },
    value: ws.id,
  }));
  options.push({
    text: {
      tag: "plain_text" as const,
      content: "🔌 取消绑定（回到默认 workspace）",
    },
    value: SWITCH_DETACH_VALUE,
  });

  const initial =
    preselected && workspaces.some((ws) => ws.id === preselected)
      ? preselected
      : options[0]?.value;

  return {
    tag: "select_static",
    name: SWITCH_FIELD.workspaceId,
    placeholder: { tag: "plain_text", content: "选择一个 workspace" },
    initial_option: initial,
    options,
    width: "fill",
  };
}

function _buildSubmitButton(): ButtonElement {
  // Uses `action_type: "form_submit"` — Feishu's form container needs at
  // least one submit-type button; mixing `behaviors: [{type:"callback"}]`
  // here would cause the container to reject the button as non-submit
  // ("there is no submit button in the form container").
  return {
    tag: "button",
    name: "switch_submit",
    text: { tag: "plain_text", content: "✅ 切换" },
    type: "primary",
    action_type: "form_submit",
  };
}
