import { z } from "zod";

import type {
  ButtonElement,
  Card,
  CheckerElement,
  ColumnSetElement,
  Element,
  FormElement,
  SelectStaticElement,
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

// ---------------------------------------------------------------------------
// AskUserQuestion — clarifying-question cards
//
// Claude Code's built-in `AskUserQuestion` tool rides the same
// `--permission-prompt-tool` channel as ordinary tool approvals, but its
// semantics differ: the user must *answer* multiple-choice questions, not
// approve/deny a side effect. Returning `behavior:"allow"` without an
// `answers` map makes Claude resolve the call with empty answers, so we
// render a real form, collect selections, and echo them back as
// `updatedInput: { questions, answers }`.
// ---------------------------------------------------------------------------

/**
 * One choice inside an {@link AskUserQuestionItem}. Field names mirror the
 * Claude tool contract verbatim (no underscore_case) so the payload round-trips
 * unchanged.
 */
export const AskUserQuestionOption = z.object({
  label: z.string(),
  description: z.string().optional(),
});
export interface AskUserQuestionOption
  extends z.infer<typeof AskUserQuestionOption> {}

/**
 * A single clarifying question. `multiSelect` allows picking more than one
 * option; `header` is a short label Claude attaches for display.
 */
export const AskUserQuestionItem = z.object({
  question: z.string(),
  header: z.string().optional(),
  options: z.array(AskUserQuestionOption).min(1),
  multiSelect: z.boolean().optional(),
});
export interface AskUserQuestionItem
  extends z.infer<typeof AskUserQuestionItem> {}

/**
 * The `tool_input` Claude sends when invoking `AskUserQuestion`. Parsed with
 * {@link AskUserQuestionInput.safeParse} before rendering; a parse failure is
 * treated as a deny so a malformed payload can't stall the tool call.
 */
export const AskUserQuestionInput = z.object({
  questions: z.array(AskUserQuestionItem).min(1),
});
export interface AskUserQuestionInput
  extends z.infer<typeof AskUserQuestionInput> {}

/**
 * `action` discriminator for the question form's submit button. Form-submit
 * buttons carry no `behaviors[].value`, so this rides on the button `name`,
 * which Feishu echoes as `action.name` and the channel maps to `action_name`.
 */
export const QUESTION_ACTION = "permission_question_submit";

/** `form_value` field-name helpers for the question card. */
export const QUESTION_FIELD = {
  /** Single-select dropdown for question `qi`; value is the option index. */
  select: (qi: number): string => `q${qi}`,
  /** Multi-select checker for option `oi` of question `qi`. */
  checker: (qi: number, oi: number): string => `q${qi}_o${oi}`,
};

/**
 * Render an interactive form that surfaces Claude's clarifying questions.
 * Single-select questions become a dropdown; multi-select questions become a
 * column of checkers. `warning` is shown when a previous submit was rejected
 * for being incomplete.
 */
export function buildQuestionCard(options: {
  request_id: string;
  questions: AskUserQuestionItem[];
  initiator_open_id: string;
  warning?: string;
}): Card {
  const formElements: Element[] = [];
  options.questions.forEach((q, qi) => {
    const heading = q.header?.trim() ? q.header.trim() : `问题 ${qi + 1}`;
    formElements.push(buildMarkdown(`**${heading}**\n${q.question}`));
    if (q.multiSelect) {
      formElements.push(
        buildMarkdown("<font color='grey'>可多选</font>", {
          text_size: "notation",
        }),
      );
      q.options.forEach((opt, oi) => {
        const checker: CheckerElement = {
          tag: "checker",
          name: QUESTION_FIELD.checker(qi, oi),
          text: { tag: "plain_text", content: _optionText(opt) },
          checked: false,
        };
        formElements.push(checker);
      });
    } else {
      const select: SelectStaticElement = {
        tag: "select_static",
        name: QUESTION_FIELD.select(qi),
        placeholder: { tag: "plain_text", content: "请选择" },
        options: q.options.map((opt, oi) => ({
          text: { tag: "plain_text", content: _optionText(opt) },
          value: String(oi),
        })),
        width: "fill",
      };
      formElements.push(select);
    }
  });
  formElements.push(_buildQuestionSubmitButton());

  const form: FormElement = {
    tag: "form",
    name: "permission_question_form",
    elements: formElements,
  };

  const elements: Element[] = [
    buildCardIntro({
      title: "❓ 需要你的选择",
      subtitle: "Claude Code 需要你回答以下问题才能继续",
    }),
    buildMarkdown(`- 发起人：<at id=${options.initiator_open_id}></at>`),
  ];
  if (options.warning) {
    elements.push(
      buildMarkdown(`<font color='red'>⚠️ ${options.warning}</font>`),
    );
  }
  elements.push(form);

  return {
    schema: "2.0",
    config: {
      streaming_mode: false,
      update_multi: true,
      width_mode: "fill",
      summary: { content: "❓ Claude 需要你回答" },
    },
    body: {
      padding: "12px 16px 16px 16px",
      vertical_spacing: "12px",
      elements,
    },
  };
}

/**
 * Terminal card shown after the question round-trip resolves (answered /
 * timeout / already-answered / expired). Replaces the form in place.
 */
export function buildQuestionResultCard(options: {
  outcome: "answered" | "timeout" | "already_answered" | "expired";
  detail?: string[];
}): Card {
  let summary: string;
  switch (options.outcome) {
    case "answered":
      summary = "✅ 已收到你的回答。";
      break;
    case "timeout":
      summary = "⚠️  5 分钟内未回答，已按取消处理。";
      break;
    case "already_answered":
      summary = "ℹ️  该问题已经回答过。";
      break;
    case "expired":
      summary = "⚠️  该问题卡片已失效。";
      break;
  }
  return buildResultCard({
    title: "Claude 的问题",
    summary,
    detail: options.detail,
  });
}

function _optionText(opt: AskUserQuestionOption): string {
  const desc = opt.description?.trim();
  const text = desc ? `${opt.label} — ${desc}` : opt.label;
  return text.length > 100 ? text.slice(0, 99) + "…" : text;
}

function _buildQuestionSubmitButton(): ButtonElement {
  return {
    tag: "button",
    name: QUESTION_ACTION,
    text: { tag: "plain_text", content: "✅ 提交回答" },
    type: "primary",
    action_type: "form_submit",
    width: "fill",
  };
}
