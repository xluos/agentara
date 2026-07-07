import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  buildAgentCancelledContent,
  buildAgentFailureContent,
} from "@/kernel/agent-failure";
import { AgentCliExitError, config } from "@/shared";

describe("buildAgentFailureContent", () => {
  test("renders cancellation separately from failures", () => {
    expect(buildAgentCancelledContent()).toEqual([
      {
        type: "text",
        text: "⏹️ 任务已取消。",
      },
    ]);
  });

  test("renders runner startup failures as visible assistant text", () => {
    const content = buildAgentFailureContent(
      new Error("检测到当前出口 IP 不在美国（country=CN）"),
    );

    expect(content).toEqual([
      {
        type: "text",
        text: expect.stringContaining("Agent 启动或执行失败"),
      },
    ]);
    const first = content[0]!;
    if (first.type !== "text") throw new Error("expected text content");
    expect(first.text).toContain("country=CN");
    expect(first.text).toContain("代理或出口环境检查失败");
    expect(first.text).toContain("Clash");
  });

  test("falls back for non-Error throws", () => {
    const content = buildAgentFailureContent("boom");

    const first = content[0]!;
    if (first.type !== "text") throw new Error("expected text content");
    expect(first.text).toContain("boom");
  });

  test("summarizes Claude session limit and persists full CLI output", () => {
    const home = mkdtempSync(join(tmpdir(), "agentara-failure-test-"));
    const originalPaths = config.paths;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests override lazily resolved paths.
      (config as any).paths = {
        ...config.paths,
        runtime_logs: join(home, "runtime-logs"),
      };
      const stdout = [
        '{"type":"assistant","message":{"content":[{"type":"text","text":"ignored"}]}}',
        "{\"type\":\"result\",\"is_error\":true,\"api_error_status\":429,\"result\":\"You've hit your session limit · resets 8:50pm (Asia/Shanghai)\"}",
      ].join("\n");
      const content = buildAgentFailureContent(
        new AgentCliExitError({
          runner: "Claude Code",
          exitCode: 1,
          stdout,
          stderr: "full stderr",
        }),
        { sessionId: "session_1" },
      );

      const first = content[0]!;
      if (first.type !== "text") throw new Error("expected text content");
      expect(first.text).toContain("Claude 账号达到 session limit");
      expect(first.text).toContain("8:50pm (Asia/Shanghai)");
      const match = first.text.match(/完整错误已落盘：`([^`]+)`/);
      expect(match?.[1]).toBeTruthy();
      const artifactPath = match![1]!;
      expect(existsSync(artifactPath)).toBe(true);
      const artifact = readFileSync(artifactPath, "utf-8");
      expect(artifact).toContain(stdout);
      expect(artifact).toContain("full stderr");
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- restore test override.
      (config as any).paths = originalPaths;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("prioritizes CLI auth failures over proxy words in injected context", () => {
    const stdout = [
      '{"type":"system","subtype":"hook_response","output":"dev-memory mentions proxy and Clash in unrelated context"}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"Not logged in · Please run /login"}]},"error":"authentication_failed"}',
      '{"type":"result","is_error":true,"result":"Not logged in · Please run /login"}',
    ].join("\n");

    const content = buildAgentFailureContent(
      new AgentCliExitError({
        runner: "Claude Code",
        exitCode: 1,
        stdout,
      }),
    );

    const first = content[0]!;
    if (first.type !== "text") throw new Error("expected text content");
    expect(first.text).toContain("登录态失效");
    expect(first.text).toContain("/login");
    expect(first.text).not.toContain("代理或出口环境检查失败");
  });
});
