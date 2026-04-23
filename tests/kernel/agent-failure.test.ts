import { describe, expect, test } from "bun:test";

import {
  buildAgentCancelledContent,
  buildAgentFailureContent,
} from "@/kernel/agent-failure";

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
    expect(first.text).toContain("/agent use <type>");
  });

  test("falls back for non-Error throws", () => {
    const content = buildAgentFailureContent("boom");

    const first = content[0]!;
    if (first.type !== "text") throw new Error("expected text content");
    expect(first.text).toContain("boom");
  });
});
