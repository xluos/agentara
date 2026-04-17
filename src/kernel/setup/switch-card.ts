import type { Workspace } from "@/shared";

import type {
  ButtonElement,
  Card,
  Element,
  FormElement,
  SelectStaticElement,
} from "../../community/feishu/messaging/types";

import {
  buildCardIntro,
  buildMarkdown,
  buildResultCard,
  buildSectionBlock,
} from "./card-ui";

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
 * Build the `/switch` card with a richer structure than the old plain
 * markdown version: card head, current-binding summary, and a clearer form
 * section that explains the detach option.
 */
export function buildSwitchCard(options: SwitchCardOptions): Card {
  const { workspaces, current } = options;

  const body: Element[] = [
    buildCardIntro({
      title: "切换 Workspace",
    }),
  ];

  if (current) {
    body.push(...buildSectionBlock({
      title: "当前绑定",
      lines: [
        `- 名称：\`${current.workspace_name}\``,
        `- ID：\`${current.workspace_id}\``,
        `- 活跃仓库：\`${current.active_repo ?? "(未设置)"}\``,
        `- 活跃分支：\`${current.active_branch ?? "(未设置)"}\``,
      ],
    }));
  } else {
    body.push(...buildSectionBlock({
      title: "当前绑定",
      lines: ["- 当前会话未绑定 workspace"],
    }));
  }

  const select = _buildWorkspaceSelect(workspaces, current?.workspace_id);
  const submit = _buildSubmitButton();
  const form: FormElement = {
    tag: "form",
    name: "switch_form",
    elements: [
      buildMarkdown("**目标 Workspace**"),
      select,
      submit,
    ],
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
    body: {
      padding: "12px 16px 16px 16px",
      vertical_spacing: "12px",
      elements: body,
    },
  };
}

/**
 * Result card rendered after the submit handler finishes. Replaces the
 * original card in place via `updateRawCard`.
 */
export function buildSwitchResultCard(summary: string, detail: string[] = []): Card {
  return buildResultCard({
    title: "Workspace 切换结果",
    summary,
    detail,
  });
}

function _buildWorkspaceSelect(
  workspaces: Workspace[],
  preselected?: string,
): SelectStaticElement {
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
  return {
    tag: "button",
    name: "switch_submit",
    text: { tag: "plain_text", content: "确认切换" },
    type: "primary",
    action_type: "form_submit",
    width: "fill",
  };
}
