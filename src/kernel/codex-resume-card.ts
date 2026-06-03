import type {
  ButtonElement,
  Card,
  ColumnSetElement,
} from "@/community/feishu/messaging/types";

import { buildCardIntro, buildMarkdown, buildResultCard } from "./setup/card-ui";

export const CODEX_RESUME_RESTART_ACTION = "codex_resume_restart";

export interface CodexResumeRestartValue {
  action: typeof CODEX_RESUME_RESTART_ACTION;
  [key: string]: unknown;
}

export function buildCodexResumeMissingCard(options: {
  resumeId: string;
}): Card {
  return {
    schema: "2.0",
    config: {
      streaming_mode: false,
      update_multi: true,
      width_mode: "fill",
      summary: {
        content: "Codex 续接失败",
      },
    },
    body: {
      padding: "12px 16px 16px 16px",
      vertical_spacing: "12px",
      elements: [
        buildCardIntro({
          title: "Codex 续接失败",
          subtitle: "本地 Codex 找不到上一轮 rollout",
        }),
        buildMarkdown(
          [
            `- Thread ID：\`${options.resumeId}\``,
            "- 原因：Codex 本地会话库里没有这个 rollout，可能是 `CODEX_HOME` 变化、会话文件被清理，或旧会话记录来自不同运行环境。",
            "- 当前不会自动重开。确认可以丢弃 Codex CLI 的续跑状态后，再点击下面按钮。",
          ].join("\n"),
        ),
        _buildRestartButtonRow(),
      ],
    },
  };
}

export function buildCodexResumeRestartingCard(): Card {
  return buildResultCard({
    title: "Codex 续接恢复",
    summary: "⏳ 正在重新开始 Codex 会话…",
  });
}

export function buildCodexResumeRestartedCard(): Card {
  return buildResultCard({
    title: "Codex 续接恢复",
    summary: "✅ 已重新开始 Codex 会话，新回复会在话题内继续生成。",
  });
}

export function buildCodexResumeExpiredCard(): Card {
  return buildResultCard({
    title: "Codex 续接恢复",
    summary: "⚠️  这张恢复卡片已失效，请重新发送消息触发恢复提示。",
  });
}

export function formatCodexResumeMissingText(resumeId: string): string {
  return [
    "Codex 续接失败：本地 Codex 找不到上一轮 rollout。",
    "",
    `Thread ID：${resumeId}`,
    "",
    "当前不会自动重开。请在 Feishu 卡片上点击「重新开始 Codex 会话」，或手动开启新会话。",
  ].join("\n");
}

function _buildRestartButtonRow(): ColumnSetElement {
  const value: CodexResumeRestartValue = {
    action: CODEX_RESUME_RESTART_ACTION,
  };
  const button: ButtonElement = {
    tag: "button",
    name: "codex_resume_restart",
    text: { tag: "plain_text", content: "重新开始 Codex 会话" },
    type: "primary",
    width: "fill",
    behaviors: [{ type: "callback", value }],
  };
  return {
    tag: "column_set",
    flex_mode: "stretch",
    columns: [
      {
        tag: "column",
        width: "weighted",
        weight: 1,
        elements: [button],
      },
    ],
  };
}
