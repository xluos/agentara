import { describe, expect, test } from "bun:test";

import {
  getRuntimeDefaultAgentType,
  setRuntimeDefaultAgentType,
} from "@/kernel/agents";
import {
  CommandRegistry,
  type CommandContext,
  type CommandHandler,
} from "@/kernel/commands";

function getHandler(name: string): CommandHandler {
  const handler = new CommandRegistry().get(name);
  if (!handler) throw new Error(`missing command handler: ${name}`);
  return handler;
}

function makeContext(args: string[]): CommandContext {
  return {
    args,
    raw: `/${args.join(" ")}`,
    message: {
      id: "msg_1",
      role: "user",
      session_id: "session_1",
      channel_id: "ch_1",
      chat_id: "oc_1",
      chat_type: "group",
      content: [{ type: "text", text: "/agent" }],
    },
    workspaceStore: {},
    feishuChannels: new Map(),
    logger: {
      info() {},
      warn() {},
      error() {},
      debug() {},
      trace() {},
      fatal() {},
      child() {
        return this;
      },
    },
  } as unknown as CommandContext;
}

describe("agent management commands", () => {
  test("/agents lists available runners and marks the active one", async () => {
    setRuntimeDefaultAgentType("codex");
    const result = await getHandler("agents").execute(makeContext([]));

    expect(typeof result).not.toBe("string");
    if (typeof result === "string") throw new Error("expected card result");
    expect(result.fallback_text).toContain("当前默认 Agent");
    expect(result.fallback_text).toContain("可选 Agent");
    expect(result.fallback_text).toContain("`codex`");
    expect(result.fallback_text).toContain("当前");
  });

  test("/agent use switches the runtime default for new sessions", async () => {
    setRuntimeDefaultAgentType("claude");
    const result = await getHandler("agent").execute(
      makeContext(["use", "dummy"]),
    );

    expect(getRuntimeDefaultAgentType()).toBe("dummy");
    expect(typeof result).not.toBe("string");
    if (typeof result === "string") throw new Error("expected card result");
    expect(result.fallback_text).toContain("dummy");
    expect(result.fallback_text).toContain("新 session");
  });

  test("/agent accepts a direct runner type shorthand", async () => {
    setRuntimeDefaultAgentType("claude");
    await getHandler("agent").execute(makeContext(["codex"]));

    expect(getRuntimeDefaultAgentType()).toBe("codex");
  });

  test("/agent matches runner types case-insensitively", async () => {
    setRuntimeDefaultAgentType("claude");
    await getHandler("agent").execute(makeContext(["Codex"]));

    expect(getRuntimeDefaultAgentType()).toBe("codex");
  });

  test("/agent rejects unknown runner types with the available list", async () => {
    const result = await getHandler("agent").execute(makeContext(["missing"]));

    expect(typeof result).not.toBe("string");
    if (typeof result === "string") throw new Error("expected card result");
    expect(result.fallback_text).toContain("未知 Agent");
    expect(result.fallback_text).toContain("可选 Agent");
    expect(result.fallback_text).toContain("`codex`");
  });
});
