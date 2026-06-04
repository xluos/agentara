import { describe, expect, test } from "bun:test";

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

interface ContextOverrides {
  thread_id?: string;
  chat_id?: string;
  chat_type?: "group" | "single";
  channel_id?: string;
  session?: { agent_type: string; runner_session_id: string | null };
  task_status?: "running" | "pending";
  usage?: { message_id: string; used_tokens: number; model?: string };
  thread_auto_respond?: boolean;
}

function makeContext(overrides: ContextOverrides = {}): CommandContext {
  return {
    args: [],
    raw: "/topic",
    message: {
      id: "msg_1",
      role: "user",
      session_id: "session_1",
      channel_id: overrides.channel_id ?? "ch_1",
      chat_id: overrides.chat_id ?? "oc_1",
      chat_type: overrides.chat_type ?? "group",
      thread_id: overrides.thread_id,
      content: [{ type: "text", text: "/topic" }],
    },
    workspaceStore: {},
    feishuChannels: new Map([
      [
        overrides.channel_id ?? "ch_1",
        {
          getThreadInfo() {
            if (overrides.thread_auto_respond === undefined) return undefined;
            return {
              session_id: "session_1",
              auto_respond: overrides.thread_auto_respond,
            };
          },
        },
      ],
    ]),
    sessionManager: {
      getSession() {
        return overrides.session
          ? {
              id: "session_1",
              agent_type: overrides.session.agent_type,
              cwd: "/tmp",
              first_message: "",
              runner_session_id: overrides.session.runner_session_id,
              last_message_created_at: null,
              created_at: 0,
              updated_at: 0,
            }
          : undefined;
      },
    },
    taskDispatcher: {
      getActiveTaskStatusForSession() {
        return overrides.task_status;
      },
    },
    readSessionUsageSnapshot() {
      return overrides.usage;
    },
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

describe("/topic command", () => {
  test("renders session and chat identifiers", async () => {
    const result = await getHandler("topic").execute(
      makeContext({
        thread_id: "omt_xyz",
        session: { agent_type: "claude-code", runner_session_id: "run_42" },
        task_status: "running",
        usage: {
          message_id: "assistant_1",
          used_tokens: 215_000,
          model: "claude-sonnet",
        },
        thread_auto_respond: false,
      }),
    );
    expect(typeof result).not.toBe("string");
    if (typeof result === "string") throw new Error("expected card result");
    expect(result.fallback_text).toContain("话题信息");
    expect(result.fallback_text).toContain("`session_1`");
    expect(result.fallback_text).toContain("`omt_xyz`");
    expect(result.fallback_text).toContain("`oc_1 (群聊)`");
    expect(result.fallback_text).toContain("群聊");
    expect(result.fallback_text).toContain("claude-code");
    expect(result.fallback_text).not.toContain("run_42");
    expect(result.fallback_text).not.toContain("Codex 会话 ID");
    expect(result.fallback_text).toContain("当前任务状态");
    expect(result.fallback_text).toContain("`running`");
    expect(result.fallback_text).toContain("当前 Token");
    expect(result.fallback_text).toContain("`215k`");
    expect(result.fallback_text).toContain("claude-sonnet");
    expect(result.fallback_text).toContain("话题免 @");
    expect(result.fallback_text).toContain("默认，需 @ 机器人");
  });

  test("notes a missing thread context outside topics", async () => {
    const result = await getHandler("topic").execute(
      makeContext({
        session: { agent_type: "codex", runner_session_id: null },
      }),
    );
    if (typeof result === "string") throw new Error("expected card result");
    expect(result.fallback_text).toContain("(不在话题内)");
    expect(result.fallback_text).toContain("Codex 会话 ID：(尚未建立)");
    expect(result.fallback_text).toContain("`idle`");
    expect(result.fallback_text).toContain("当前 Token：(暂无统计)");
    expect(result.fallback_text).not.toContain("话题免 @");
  });

  test("flags missing session row", async () => {
    const result = await getHandler("topic").execute(makeContext({}));
    if (typeof result === "string") throw new Error("expected card result");
    expect(result.fallback_text).toContain("数据库尚无该 session 记录");
  });
});
