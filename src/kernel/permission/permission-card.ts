import type {
  ButtonElement,
  Card,
  ColumnSetElement,
  Element,
} from "../../community/feishu/messaging/types";
import {
  buildCardIntro,
  buildMarkdown,
  buildResultCard,
} from "../setup/card-ui";

/**
 * `action` discriminator echoed back on `card.action.trigger` when the
 * user clicks Approve or Deny. Matched by {@link PermissionFlow}.
 */
export const PERMISSION_ACTION = "permission_decide";

/**
 * Payload attached to each permission button's callback. The decision is
 * the click result; `request_id` correlates with the pending map in
 * {@link PermissionFlow}.
 *
 * `allow_session` is a session-scoped "always allow this tool" shortcut —
 * the flow adds the tool name to an in-memory allow list keyed by
 * `session_id`, so subsequent calls for the same tool don't prompt again.
 * Scope is the current session only and the list clears on kernel restart.
 *
 * The index signature is there only to satisfy the `CallbackValue =
 * Record<string, unknown>` contract on {@link CallbackBehavior}; the
 * real shape is the three named fields above it.
 */
export interface PermissionCallbackValue {
  action: typeof PERMISSION_ACTION;
  request_id: string;
  decision: "allow" | "deny" | "allow_session";
  [key: string]: unknown;
}

/**
 * Build the permission-request card shown to the initiator. The body
 * stays intentionally flat: a short summary line + a collapsible JSON
 * block for the raw input, so scanability wins for simple tools while
 * power users can still inspect the exact args.
 */
export function buildPermissionCard(options: {
  request_id: string;
  tool_name: string;
  tool_input: unknown;
  initiator_open_id: string;
}): Card {
  const preview = _formatInputPreview(options.tool_input);
  const elements: Element[] = [
    buildCardIntro({
      title: "🔒 权限请求",
      subtitle: `Claude Code 请求调用工具 \`${options.tool_name}\``,
    }),
    buildMarkdown(
      [
        `- 发起人：<at id=${options.initiator_open_id}></at>`,
        `- 工具：\`${options.tool_name}\``,
      ].join("\n"),
    ),
  ];

  if (preview) {
    elements.push(
      buildMarkdown("<font color='grey'>调用参数</font>", {
        text_size: "notation",
      }),
      buildMarkdown("```json\n" + preview + "\n```"),
    );
  }

  elements.push(...buildButtonRows(options.request_id));

  return {
    schema: "2.0",
    config: {
      streaming_mode: false,
      update_multi: true,
      width_mode: "fill",
      summary: {
        content: `🔒 权限请求：${options.tool_name}`,
      },
    },
    body: {
      padding: "12px 16px 16px 16px",
      vertical_spacing: "12px",
      elements,
    },
  };
}

/**
 * Terminal card shown after a decision is made (approve / deny / timeout
 * / wrong operator / already-decided). Replaces the original card in
 * place.
 */
export function buildPermissionResultCard(options: {
  tool_name: string;
  outcome:
    | "allowed"
    | "allowed_session"
    | "denied"
    | "timeout"
    | "wrong_operator"
    | "already_decided"
    | "expired";
  decided_by_open_id?: string;
}): Card {
  const { tool_name, outcome } = options;
  const decided_by = options.decided_by_open_id;
  let summary: string;
  switch (outcome) {
    case "allowed":
      summary = decided_by
        ? `✅ <at id=${decided_by}></at> 已批准 \`${tool_name}\`。`
        : `✅ 已批准 \`${tool_name}\`。`;
      break;
    case "allowed_session":
      summary = decided_by
        ? `🔓 <at id=${decided_by}></at> 已批准 \`${tool_name}\`，并在本次会话内对该工具放行。`
        : `🔓 已批准 \`${tool_name}\`，并在本次会话内对该工具放行。`;
      break;
    case "denied":
      summary = decided_by
        ? `🚫 <at id=${decided_by}></at> 已拒绝 \`${tool_name}\`。`
        : `🚫 已拒绝 \`${tool_name}\`。`;
      break;
    case "timeout":
      summary = `⚠️  5 分钟内未响应，已按拒绝处理 \`${tool_name}\`。`;
      break;
    case "wrong_operator":
      summary = "🚫 这不是你的权限卡片，只有发起人可以决定。";
      break;
    case "already_decided":
      summary = "ℹ️  该权限请求已经处理过。";
      break;
    case "expired":
      summary = "⚠️  该权限请求已失效。";
      break;
  }
  return buildResultCard({
    title: "权限请求",
    summary,
  });
}

function _formatInputPreview(input: unknown): string {
  if (input === undefined || input === null) return "";
  try {
    const text = JSON.stringify(input, null, 2);
    if (text.length <= 1200) return text;
    return text.slice(0, 1200) + "\n… (truncated)";
  } catch {
    return String(input);
  }
}

function buildButtonRows(requestId: string): Element[] {
  const mkValue = (
    decision: PermissionCallbackValue["decision"],
  ): PermissionCallbackValue => ({
    action: PERMISSION_ACTION,
    request_id: requestId,
    decision,
  });
  const approveBtn: ButtonElement = {
    tag: "button",
    name: "permission_allow",
    text: { tag: "plain_text", content: "✅ 批准" },
    type: "primary",
    width: "fill",
    behaviors: [{ type: "callback", value: mkValue("allow") }],
  };
  const denyBtn: ButtonElement = {
    tag: "button",
    name: "permission_deny",
    text: { tag: "plain_text", content: "🚫 拒绝" },
    type: "danger",
    width: "fill",
    behaviors: [{ type: "callback", value: mkValue("deny") }],
  };
  const allowSessionBtn: ButtonElement = {
    tag: "button",
    name: "permission_allow_session",
    text: {
      tag: "plain_text",
      content: "🔓 批准并在本次会话内不再询问该工具",
    },
    type: "default",
    width: "fill",
    behaviors: [{ type: "callback", value: mkValue("allow_session") }],
  };
  const primaryRow: ColumnSetElement = {
    tag: "column_set",
    flex_mode: "stretch",
    horizontal_spacing: "12px",
    columns: [
      { tag: "column", width: "weighted", weight: 1, elements: [approveBtn] },
      { tag: "column", width: "weighted", weight: 1, elements: [denyBtn] },
    ],
  };
  // The session-wide allow sits on its own row so its longer copy isn't
  // squashed, and users don't mistake it for the single-shot approve.
  return [primaryRow, allowSessionBtn];
}
