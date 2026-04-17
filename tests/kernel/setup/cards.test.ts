import { describe, expect, test } from "bun:test";

import { optimizeCardMarkdown } from "@/kernel/setup/card-ui";
import {
  buildSetupCard,
  buildSetupResultCard,
} from "@/kernel/setup/setup-card";
import {
  buildSwitchCard,
  buildSwitchResultCard,
  SWITCH_DETACH_VALUE,
} from "@/kernel/setup/switch-card";

describe("buildSetupCard", () => {
  test("renders richer structure for first-time setup", () => {
    const card = buildSetupCard(
      [
        {
          name: "agentara",
          description: "主仓库",
          git_url: "git@example.com/agentara.git",
        },
        {
          name: "happyclaw",
          description: "参考实现",
          git_url: "git@example.com/happyclaw.git",
        },
      ],
      {
        workspace_name: { value: "demo-space", locked: false },
      },
    );

    expect(card.head).toBeUndefined();
    expect(card.body.elements[0]).toMatchObject({
      tag: "markdown",
    });
    expect(card.body.elements[1]).toMatchObject({
      tag: "form",
    });

    const form = card.body.elements[1];
    expect(form).toBeTruthy();
    if (!form || form.tag !== "form") throw new Error("expected setup form");

    const primaryLabel = form.elements.find(
      (element) =>
        element.tag === "markdown" && element.content.includes("主仓库"),
    );
    expect(primaryLabel).toBeTruthy();

    const repoRow = form.elements.find((element) => element.tag === "column_set");
    expect(repoRow).toBeTruthy();
  });

  test("shows current-state panel for existing workspace", () => {
    const card = buildSetupCard(
      [
        {
          name: "agentara",
          description: "主仓库",
          git_url: "git@example.com/agentara.git",
        },
      ],
      {
        prefills: {
          agentara: {
            already_cloned: true,
            current_branch: "dev",
          },
        },
        primary_repo: "agentara",
        workspace_name: { value: "demo-space", locked: true, id: "ws_123" },
      },
    );

    expect(card.head).toBeUndefined();
    expect(card.body.elements[1]).toMatchObject({
      tag: "collapsible_panel",
      header: { title: { content: "当前状态" } },
    });
    expect(card.body.elements[2]).toMatchObject({ tag: "form" });
  });
});

describe("buildSwitchCard", () => {
  test("renders current binding summary and detach option", () => {
    const card = buildSwitchCard({
      workspaces: [
        {
          id: "ws_1",
          name: "alpha",
          path: "/tmp/alpha",
          active_repo: "agentara",
          active_branch: "dev",
          created_at: Date.now(),
          updated_at: Date.now(),
        },
      ],
      current: {
        workspace_id: "ws_1",
        workspace_name: "alpha",
        workspace_path: "/tmp/alpha",
        active_repo: "agentara",
        active_branch: "dev",
      },
    });

    expect(card.head).toBeUndefined();
    expect(card.body.elements[1]).toMatchObject({
      tag: "collapsible_panel",
      header: { title: { content: "当前绑定" } },
    });

    const form = card.body.elements[2];
    expect(form).toBeTruthy();
    if (!form || form.tag !== "form") throw new Error("expected switch form");

    const select = form.elements.find((element) => element.tag === "select_static");
    expect(select).toBeTruthy();
    if (select?.tag !== "select_static") throw new Error("expected select");
    expect(select.options.at(-1)?.value).toBe(SWITCH_DETACH_VALUE);
  });
});

describe("result cards", () => {
  test("derives success styling from summary", () => {
    const setupResult = buildSetupResultCard("✅ 已完成", ["- `agentara`"]);
    const switchResult = buildSwitchResultCard("⚠️  需要重新选择");

    expect(setupResult.head).toBeUndefined();
    expect(switchResult.head).toBeUndefined();
    expect(setupResult.body.elements[0]).toMatchObject({ tag: "markdown" });
  });
});

describe("optimizeCardMarkdown", () => {
  test("demotes large headings and preserves code blocks", () => {
    const optimized = optimizeCardMarkdown(
      "# Title\n\n```ts\nconst value = 1;\n```\n\n| a | b |\n| - | - |\n| 1 | 2 |",
    );

    expect(optimized).toContain("#### Title");
    expect(optimized).toContain("```ts\nconst value = 1;\n```");
    expect(optimized).toContain("<br>");
  });
});
