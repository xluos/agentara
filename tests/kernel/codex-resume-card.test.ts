import { describe, expect, test } from "bun:test";

import {
  buildCodexResumeMissingCard,
  CODEX_RESUME_RESTART_ACTION,
  formatCodexResumeMissingText,
} from "@/kernel/codex-resume-card";

describe("codex resume recovery card", () => {
  test("renders a restart callback button", () => {
    const card = buildCodexResumeMissingCard({ resumeId: "thread-123" });
    const buttonRow = card.body.elements.at(-1);

    expect(card.config?.summary.content).toBe("Codex 续接失败");
    expect(JSON.stringify(card)).toContain("thread-123");
    expect(buttonRow).toMatchObject({
      tag: "column_set",
      columns: [
        {
          elements: [
            {
              tag: "button",
              text: { content: "重新开始 Codex 会话" },
              behaviors: [
                {
                  type: "callback",
                  value: { action: CODEX_RESUME_RESTART_ACTION },
                },
              ],
            },
          ],
        },
      ],
    });
  });

  test("text fallback tells users it will not auto restart", () => {
    const text = formatCodexResumeMissingText("thread-123");

    expect(text).toContain("thread-123");
    expect(text).toContain("不会自动重开");
  });
});
