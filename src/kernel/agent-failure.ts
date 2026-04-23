import type { AssistantMessage } from "@/shared";

export function buildAgentCancelledContent(): AssistantMessage["content"] {
  return [
    {
      type: "text",
      text: "⏹️ 任务已取消。",
    },
  ];
}

export function buildAgentFailureContent(
  err: unknown,
): AssistantMessage["content"] {
  const message = err instanceof Error ? err.message : String(err);
  const detail = message.trim() || "未知错误";
  return [
    {
      type: "text",
      text: [
        "❌ Agent 启动或执行失败。",
        "",
        "```",
        detail,
        "```",
        "",
        "可以先检查当前 Agent 类型、代理/出口环境，或执行 `/agent use <type>` 后新开会话重试。",
      ].join("\n"),
    },
  ];
}
