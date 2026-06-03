import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { AgentCliExitError, clipTail, config } from "@/shared";
import type { AssistantMessage } from "@/shared";

interface FailureDisplay {
  summary: string;
  details: string[];
  suggestion: string;
}

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
  options?: { sessionId?: string },
): AssistantMessage["content"] {
  const artifactPath = persistFullAgentFailure(err, options?.sessionId);
  const display = describeAgentFailure(err);
  const rawMessage = err instanceof Error ? err.message : String(err);
  const technicalDetail = clipTail(rawMessage.trim() || "未知错误", 1800);
  const lines = [
    "❌ Agent 启动或执行失败。",
    "",
    `原因：${display.summary}`,
  ];
  if (display.details.length > 0) {
    lines.push("", ...display.details.map((line) => `- ${line}`));
  }
  lines.push("", `建议：${display.suggestion}`);
  if (artifactPath) {
    lines.push("", `完整错误已落盘：\`${artifactPath}\``);
  }
  lines.push("", "技术细节（已截断）：", "", "```", technicalDetail, "```");
  return [
    {
      type: "text",
      text: lines.join("\n"),
    },
  ];
}

function describeAgentFailure(err: unknown): FailureDisplay {
  const raw = _failureRawText(err);
  const reset = _matchFirst(raw, /You've hit your session limit · resets ([^\n"]+)/);
  if (reset) {
    return {
      summary: "Claude 账号达到 session limit（API 429），当前请求没有真正开始执行。",
      details: [`重置时间：${reset}`, "这通常是短时间内恢复多个大上下文 Claude 会话触发的额度限制。"],
      suggestion:
        "等额度重置后重试；如果是历史大会话，先发 `/compact` 或新开会话，避免继续用 300k+ tokens 上下文反复恢复。",
    };
  }

  const status = _matchFirst(raw, /"api_error_status"\s*:\s*(\d+)/);
  if (status === "429" || /rate limit|too many requests/i.test(raw)) {
    return {
      summary: "上游模型服务返回 429 限流。",
      details: [],
      suggestion: "稍后重试，或切换到其他 Agent 类型/新会话降低上下文成本。",
    };
  }

  if (/country=CN|出口 IP 不在美国|proxy|Clash TUN|HTTP 代理/i.test(raw)) {
    return {
      summary: "代理或出口环境检查失败。",
      details: [_firstNonEmptyLine(raw, ["country=", "Clash", "proxy", "代理"])],
      suggestion: "检查 Clash/TUN/HTTP_PROXY/HTTPS_PROXY 后重试，或临时切换到不带代理 gate 的 Agent。",
    };
  }

  if (/Operation not permitted|permission denied|Full Disk Access|TCC/i.test(raw)) {
    return {
      summary: "本机权限拦截导致 Agent 无法访问必要文件。",
      details: [_firstNonEmptyLine(raw, ["Operation not permitted", "permission", "TCC"])],
      suggestion: "如果进程从 LaunchAgent 启动，优先检查 macOS Full Disk Access/TCC，或把运行目录迁出 Documents。",
    };
  }

  if (/no rollout found|thread\/resume failed/i.test(raw)) {
    return {
      summary: "底层 Codex resume/thread 状态不存在，无法续接旧会话。",
      details: [_firstNonEmptyLine(raw, ["no rollout found", "thread/resume"])],
      suggestion: "点击恢复卡重新开始底层 runner session，或新开会话继续。",
    };
  }

  if (/image in the conversation could not be processed/i.test(raw)) {
    return {
      summary: "会话里有图片无法被模型处理。",
      details: [_firstNonEmptyLine(raw, ["image in the conversation"])],
      suggestion: "重新读取图片、换一种图片读取方式，或先压缩/移除该图片上下文后重试。",
    };
  }

  const runner =
    err instanceof AgentCliExitError ? `${err.runner} exited with code ${err.exitCode}` : undefined;
  return {
    summary: runner ?? "Runner 进程退出或执行异常。",
    details: [],
    suggestion: "查看技术细节和完整错误文件；必要时检查 Agent 类型、代理/出口环境，或执行 `/agent use <type>` 后新开会话重试。",
  };
}

function persistFullAgentFailure(
  err: unknown,
  sessionId?: string,
): string | undefined {
  if (!(err instanceof AgentCliExitError)) return undefined;
  const dir = join(config.paths.runtime_logs, "agent-failures");
  mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const safeSession = (sessionId ?? "unknown").replace(/[^a-zA-Z0-9_-]/g, "_");
  const safeRunner = err.runner.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const path = join(dir, `${ts}-${safeSession}-${safeRunner}.log`);
  const body = [
    `runner: ${err.runner}`,
    `exit_code: ${err.exitCode}`,
    `session_id: ${sessionId ?? ""}`,
    "",
    "=== message ===",
    err.message,
    "",
    "=== stdout ===",
    err.stdout,
    "",
    "=== stderr ===",
    err.stderr,
    "",
  ].join("\n");
  writeFileSync(path, body, "utf-8");
  return path;
}

function _failureRawText(err: unknown): string {
  if (err instanceof AgentCliExitError) {
    return [err.message, err.stdout, err.stderr].filter(Boolean).join("\n");
  }
  return err instanceof Error ? err.message : String(err);
}

function _matchFirst(text: string, regex: RegExp): string | undefined {
  return regex.exec(text)?.[1]?.trim();
}

function _firstNonEmptyLine(text: string, needles: string[]): string {
  const line =
    text
      .split(/\r?\n/)
      .find((item) => needles.some((needle) => item.includes(needle)))
      ?.trim() ?? "";
  return clipTail(line || "详见技术细节。", 240);
}
