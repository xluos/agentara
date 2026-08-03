import { describe, expect, test } from "bun:test";

import {
  getDefaultGroupChatId,
  resolveCloneWorkspacePath,
} from "@/kernel/commands/handlers";

const DEFAULT_PATH = "/agentara/workspaces/_default";

describe("clone workspace target", () => {
  test("resolves the default group chat id from the default channel", () => {
    expect(
      getDefaultGroupChatId({
        default_channel_id: "channel-default",
        channels: [
          {
            id: "channel-other",
            type: "feishu",
            name: "Other",
            description: "",
            params: { chat_id: "oc_other" },
          },
          {
            id: "channel-default",
            type: "feishu",
            name: "Default",
            description: "",
            params: { chat_id: "oc_default" },
          },
        ],
      }),
    ).toBe("oc_default");
  });

  test("single chats clone into Default", () => {
    expect(
      resolveCloneWorkspacePath({
        chatType: "single",
        chatId: "oc_single",
        defaultGroupChatId: "oc_default",
        defaultWorkspacePath: DEFAULT_PATH,
      }),
    ).toBe(DEFAULT_PATH);
  });

  test("the configured default group clones into Default", () => {
    expect(
      resolveCloneWorkspacePath({
        chatType: "group",
        chatId: "oc_default",
        defaultGroupChatId: "oc_default",
        defaultWorkspacePath: DEFAULT_PATH,
        bindingWorkspacePath: "/agentara/workspaces/ws_other",
      }),
    ).toBe(DEFAULT_PATH);
  });

  test("an unbound non-default group must bind before cloning", () => {
    expect(
      resolveCloneWorkspacePath({
        chatType: "group",
        chatId: "oc_unbound",
        defaultGroupChatId: "oc_default",
        defaultWorkspacePath: DEFAULT_PATH,
      }),
    ).toBeNull();
  });

  test("a bound non-default group clones into its workspace", () => {
    expect(
      resolveCloneWorkspacePath({
        chatType: "group",
        chatId: "oc_bound",
        defaultGroupChatId: "oc_default",
        defaultWorkspacePath: DEFAULT_PATH,
        bindingWorkspacePath: "/agentara/workspaces/ws_bound",
      }),
    ).toBe("/agentara/workspaces/ws_bound");
  });
});
