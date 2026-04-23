import { describe, expect, test } from "bun:test";

import {
  buildSettingMainCard,
  buildWorkspaceDeleteConfirmCard,
  buildWorkspaceDetailCard,
  SETTING_ACTION,
  SETTING_FIELD,
} from "@/kernel/setting/setting-card";
import type { GroupWorkspace, Workspace } from "@/shared";

import {
  findElement,
  flattenElements,
  stringifyCard,
} from "./fixtures";

function makeWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: "ws_abc",
    name: "alpha",
    path: "/tmp/ws_abc",
    active_repo: "agentara",
    active_branch: "dev",
    created_at: 1_700_000_000_000,
    updated_at: 1_700_000_000_000,
    last_active_at: Date.now(),
    ...overrides,
  };
}

describe("buildSettingMainCard", () => {
  test("renders the global-config form with all four fields", () => {
    const card = buildSettingMainCard({
      agent: {
        active_type: "claude-code",
        available_types: ["claude-code", "codex"],
      },
      config_values: {
        agent_model: "claude-sonnet-4-6",
        codex_isolate_host_env: false,
        max_retries: 3,
      },
      workspaces: [],
    });
    const flat = flattenElements(card.body.elements);
    const names = flat
      .filter((e) => "name" in e && typeof e.name === "string")
      .map((e) => (e as { name: string }).name);
    expect(names).toContain(SETTING_FIELD.agentType);
    expect(names).toContain(SETTING_FIELD.agentModel);
    expect(names).toContain(SETTING_FIELD.codexIsolateHostEnv);
    expect(names).toContain(SETTING_FIELD.maxRetries);
    expect(names).toContain(SETTING_ACTION.saveConfig);
  });

  test("empty workspace list shows the empty-state hint", () => {
    const card = buildSettingMainCard({
      agent: { active_type: "codex", available_types: ["codex"] },
      config_values: {
        agent_model: "",
        codex_isolate_host_env: true,
        max_retries: 5,
      },
      workspaces: [],
    });
    expect(stringifyCard(card)).toContain("还没有任何 workspace");
  });

  test("workspace row carries a detail callback with workspace_id", () => {
    const card = buildSettingMainCard({
      agent: { active_type: "codex", available_types: ["codex"] },
      config_values: {
        agent_model: "",
        codex_isolate_host_env: false,
        max_retries: 1,
      },
      workspaces: [
        {
          workspace: makeWorkspace(),
          binding_count: 2,
          is_current: true,
        },
      ],
    });
    const flat = flattenElements(card.body.elements);
    const detailBtn = findElement(flat, (e) =>
      "behaviors" in e &&
      Array.isArray((e as { behaviors?: unknown[] }).behaviors) &&
      JSON.stringify(e).includes(SETTING_ACTION.wsDetail),
    );
    expect(detailBtn).toBeDefined();
    expect(JSON.stringify(detailBtn)).toContain("ws_abc");
    expect(stringifyCard(card)).toContain("当前群");
    expect(stringifyCard(card)).toContain("2 群绑定");
  });
});

describe("buildWorkspaceDetailCard", () => {
  test("shows bindings, repos, and both back + delete buttons", () => {
    const bindings: GroupWorkspace[] = [
      {
        chat_id: "oc_xx",
        workspace_id: "ws_abc",
        workspace_name: "alpha",
        workspace_path: "/tmp/ws_abc",
        active_repo: "agentara",
        active_branch: "dev",
        created_at: 0,
        updated_at: 0,
      },
    ];
    const card = buildWorkspaceDetailCard({
      workspace: makeWorkspace(),
      bindings,
      repos: [
        { name: "agentara", branch: "dev", is_active: true },
        { name: "new-api", branch: "main", is_active: false },
      ],
      is_protected: false,
    });
    const json = stringifyCard(card);
    expect(json).toContain("oc_xx");
    expect(json).toContain("agentara");
    expect(json).toContain("new-api");
    expect(json).toContain("活跃");
    expect(json).toContain(SETTING_ACTION.mainBack);
    expect(json).toContain(SETTING_ACTION.wsDeletePrompt);
  });

  test("protected workspace only shows back button, not delete", () => {
    const card = buildWorkspaceDetailCard({
      workspace: makeWorkspace({ name: "_default", path: "/tmp/_default" }),
      bindings: [],
      repos: [],
      is_protected: true,
    });
    const json = stringifyCard(card);
    expect(json).toContain(SETTING_ACTION.mainBack);
    expect(json).not.toContain(SETTING_ACTION.wsDeletePrompt);
  });
});

describe("buildWorkspaceDeleteConfirmCard", () => {
  test("highlights the estimated blast radius and offers cancel/confirm", () => {
    const card = buildWorkspaceDeleteConfirmCard({
      workspace: makeWorkspace(),
      binding_count: 3,
      estimated_session_count: 12,
    });
    const json = stringifyCard(card);
    expect(json).toContain("解绑");
    expect(json).toContain("3");
    expect(json).toContain("12");
    expect(json).toContain(SETTING_ACTION.wsDetail); // cancel returns to detail
    expect(json).toContain(SETTING_ACTION.wsDeleteApply);
  });
});
