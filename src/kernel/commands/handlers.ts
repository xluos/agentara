import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

import {
  getAgentRuntimeState,
  resetRuntimeDefaultAgentType,
  setRuntimeDefaultAgentType,
  UnknownAgentTypeError,
} from "@/kernel/agents";
import { formatRepoRef } from "@/kernel/repo-ref";
import {
  ensureCachedMirror,
  formatAheadBehind,
  listRepoSyncState,
  readRepoHead,
  syncWorkspace,
  type RepoSyncResult,
} from "@/kernel/workspaces";
import { loadPredefinedRepos } from "@/shared";

import { buildCommandCard } from "./cards";
import type {
  CardCommandResult,
  CommandContext,
  CommandHandler,
} from "./types";

/**
 * Non-LLM commands that run inside `_handleInboundMessage` before the
 * TaskDispatcher. All commands are scoped to the current Feishu `chat_id`
 * unless noted. Missing `chat_id` means the message came from a source
 * that doesn't support group bindings; we reject those commands politely.
 *
 * User-facing copy is intentionally in Chinese — these commands surface
 * directly in Feishu group chats where the audience is Chinese-speaking.
 */

function requireChatId(ctx: CommandContext): string | null {
  const chatId = ctx.message.chat_id;
  if (!chatId) {
    return null;
  }
  return chatId;
}

/**
 * Gate for commands that may create a workspace or mutate repo state.
 * P2P (`chat_type === "single"`) is intentionally kept read/reuse-only —
 * it can browse via `/status` / `/ls` and rebind via `/switch`, but it
 * shouldn't spawn new workspaces or kick off clones. Returns the chat_id
 * when the command may proceed, or null when it should be rejected; the
 * caller picks the right error copy.
 */
function requireGroupChat(ctx: CommandContext): string | null {
  const chatId = ctx.message.chat_id;
  if (!chatId) return null;
  if (ctx.message.chat_type === "single") return null;
  return chatId;
}

async function execGit(
  args: string[],
  cwd: string,
): Promise<{ ok: boolean; stdout: string; stderr: string; code: number }> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { ok: code === 0, stdout: stdout.trim(), stderr: stderr.trim(), code };
}

function cardReply(
  title: string,
  lines: string[],
  options?: {
    sections?: Array<{ title: string; lines: string[]; expanded?: boolean }>;
    summary?: string;
  },
): CardCommandResult {
  const fallbackLines = [title, ...lines];
  for (const section of options?.sections ?? []) {
    fallbackLines.push(section.title, ...section.lines);
  }
  return {
    kind: "card",
    card: buildCommandCard({
      title,
      lines,
      sections: options?.sections,
      summary: options?.summary,
    }),
    fallback_text: fallbackLines.join("\n"),
  };
}

const AGENT_USAGE =
  "用法：`/agent`、`/agent list`、`/agent use <type>`、`/agent reset`";

function agentStatusReply(): CardCommandResult {
  const state = getAgentRuntimeState();
  const source = state.hasRuntimeOverride ? "运行时" : "配置";
  const lines = [
    `- 当前默认 Agent：\`${state.activeType}\`（${source}）`,
    state.configuredDefaultType
      ? `- 配置默认：\`${state.configuredDefaultType}\``
      : "- 配置默认：(config.yaml 未加载)",
    "- 影响范围：之后创建的新 session；已有 session 会继续使用创建时记录的 Agent。",
  ];
  const agentLines =
    state.availableTypes.length > 0
      ? state.availableTypes.map((type) => {
          const marks: string[] = [];
          if (type === state.activeType) marks.push("当前");
          if (type === state.configuredDefaultType) marks.push("配置默认");
          return `- \`${type}\`${marks.length ? ` ← ${marks.join(" / ")}` : ""}`;
        })
      : ["- (当前没有注册任何 Agent runner)"];
  return cardReply("Agent 管理", lines, {
    sections: [{ title: "可选 Agent", lines: agentLines }],
  });
}

const agentHandler: CommandHandler = {
  name: "agent",
  description: "/agent [list|use <type>|reset] — 查看或切换运行时默认 Agent",
  async execute(ctx) {
    const [verbRaw, typeRaw] = ctx.args;
    const verb = verbRaw?.toLowerCase();
    if (!verb || verb === "list" || verb === "status") {
      return agentStatusReply();
    }

    if (verb === "reset" || verb === "default") {
      const result = resetRuntimeDefaultAgentType();
      return cardReply("Agent 管理", [
        result.changed
          ? `✅ 已恢复配置默认 Agent：\`${result.currentType}\``
          : `ℹ️  当前已经是配置默认 Agent：\`${result.currentType}\``,
      ]);
    }

    const requestedType =
      verb === "use" || verb === "switch" || verb === "set"
        ? typeRaw
        : verbRaw;
    if (!requestedType) {
      return cardReply("Agent 管理", [
        AGENT_USAGE,
        "- 可先执行 `/agent list` 查看可选项。",
      ]);
    }

    try {
      const result = setRuntimeDefaultAgentType(requestedType);
      ctx.logger.info(
        {
          previous_agent_type: result.previousType,
          current_agent_type: result.currentType,
        },
        "runtime default agent switched",
      );
      return cardReply("Agent 管理", [
        result.changed
          ? `✅ 已切换运行时默认 Agent：\`${result.previousType}\` → \`${result.currentType}\``
          : `ℹ️  当前默认 Agent 已经是 \`${result.currentType}\``,
        "- 之后创建的新 session 会使用这个 Agent；已有 session 不会被强制切换。",
      ]);
    } catch (err) {
      if (err instanceof UnknownAgentTypeError) {
        return cardReply("Agent 管理", [
          `❌ 未知 Agent：\`${err.type}\``,
          AGENT_USAGE,
        ], {
          sections: [
            {
              title: "可选 Agent",
              lines: err.availableTypes.map((type) => `- \`${type}\``),
            },
          ],
        });
      }
      throw err;
    }
  },
};

const agentsHandler: CommandHandler = {
  name: "agents",
  description: "/agents — 查看可选 Agent 列表",
  async execute() {
    return agentStatusReply();
  },
};

const bindHandler: CommandHandler = {
  name: "bind",
  description: "/bind [workspace-id] — 绑定当前群到一个 workspace；传 id 时复用已有空间",
  async execute(ctx) {
    const chatId = requireGroupChat(ctx);
    if (!chatId) {
      if (ctx.message.chat_type === "single") {
        return "❌ /bind 仅在飞书群内可用；单聊请使用 `/switch` 挑选已有 workspace。";
      }
      return "❌ /bind 仅在飞书群内可用。";
    }
    const [workspaceId] = ctx.args;
    if (workspaceId) {
      const workspace = ctx.workspaceStore.getWorkspace(workspaceId);
      if (!workspace) {
        return `❌ workspace id \`${workspaceId}\` 不存在。先在已有群里执行 \`/status\` 或 \`/setup\` 获取正确的 id。`;
      }
      // Don't reset active_repo/active_branch here — they live on the
      // workspace and are shared by every bound group. Inherit whatever the
      // workspace already has.
      const binding = ctx.workspaceStore.upsertBinding(chatId, {
        workspace_id: workspaceId,
      });
      ctx.logger.info(
        { chat_id: chatId, workspace_id: workspaceId, binding },
        "group rebound to existing workspace",
      );
      const activeLine = binding.active_repo
        ? `- 活跃仓库：\`${formatRepoRef(
            binding.active_repo,
            readRepoHead(join(binding.workspace_path, binding.active_repo)),
          )}\``
        : "- 活跃仓库：(未设置)";
      return cardReply("绑定 Workspace", [
        `✅ 当前群已绑定到 \`${binding.workspace_name}\``,
        `- Workspace ID：\`${binding.workspace_id}\``,
        activeLine,
      ]);
    }
    const existing = ctx.workspaceStore.getBinding(chatId);
    // Empty patch: just ensure the binding row + workspace dir exist; don't
    // touch active_repo/active_branch (those are managed by /setup).
    const binding = ctx.workspaceStore.upsertBinding(chatId, {});
    ctx.logger.info({ chat_id: chatId, binding }, "group binding ensured");
    if (existing) {
      return cardReply("绑定 Workspace", [
        `ℹ️  当前群已绑定 \`${binding.workspace_name}\``,
        `- Workspace ID：\`${binding.workspace_id}\``,
      ]);
    }
    return cardReply("绑定 Workspace", [
      `✅ 已创建 \`${binding.workspace_name}\``,
      `- Workspace ID：\`${binding.workspace_id}\``,
      "- 下一步：`/setup`",
    ]);
  },
};

const unbindHandler: CommandHandler = {
  name: "unbind",
  description: "/unbind — 清除当前群的绑定（回退到默认 workspace）",
  async execute(ctx) {
    const chatId = requireGroupChat(ctx);
    if (!chatId) {
      if (ctx.message.chat_type === "single") {
        return "❌ /unbind 仅在飞书群内可用；单聊请使用 `/switch` 并选择「取消绑定」。";
      }
      return "❌ /unbind 仅在飞书群内可用。";
    }
    const removed = ctx.workspaceStore.deleteBinding(chatId);
    if (!removed) return cardReply("解绑 Workspace", ["ℹ️  当前群未绑定。"]);
    return cardReply("解绑 Workspace", ["✅ 已清除群绑定。"]);
  },
};

const statusHandler: CommandHandler = {
  name: "status",
  description: "/status — 查看当前群的绑定及已克隆的仓库",
  async execute(ctx) {
    const chatId = requireChatId(ctx);
    if (!chatId) {
      return cardReply("Workspace 状态", ["ℹ️  当前不在飞书会话上下文，使用默认 workspace。"]);
    }
    const resolution = ctx.workspaceStore.resolve(chatId);
    const isP2P = ctx.message.chat_type === "single";
    const lines: string[] = [];
    if (!resolution.binding) {
      lines.push(
        isP2P
          ? "ℹ️  当前单聊 **未绑定** 任何 workspace。"
          : "ℹ️  当前群 **未绑定**。",
      );
      if (isP2P) {
        lines.push("- 可用：`/switch`");
      } else {
        lines.push("- 可用：`/setup`  `/bind <workspace-id>`  `/switch`");
      }
      return cardReply("Workspace 状态", lines);
    }
    lines.push("**当前群绑定：**");
    lines.push(`- Workspace ID：\`${resolution.binding.workspace_id}\``);
    lines.push(`- Workspace 名称：\`${resolution.binding.workspace_name}\``);
    const activeRepo = resolution.binding.active_repo;
    const repoStates = listRepoSyncState(resolution.binding.workspace_path);
    // Always read branch from on-disk HEAD, not the stored `active_branch`
    // hint — the runner never force-checks-out, so "active" means "whatever
    // the repo is currently on".
    const activeState = activeRepo
      ? repoStates.find((s) => s.name === activeRepo)
      : undefined;
    const activeLabel = activeRepo
      ? `\`${formatRepoRef(activeRepo, activeState?.branch)}\``
      : "(未设置)";
    lines.push(`- 活跃仓库：${activeLabel}`);
    if (repoStates.length > 0) {
      const repoLines: string[] = [];
      for (const s of repoStates) {
        const primary = s.name === activeRepo ? " ← 活跃" : "";
        const ahead_behind = formatAheadBehind(s.ahead, s.behind);
        const dirty = s.dirty ? " •" : "";
        const label = formatRepoRef(s.name, s.branch);
        const suffix = ahead_behind ? ` ${ahead_behind}` : "";
        repoLines.push(`- \`${label}\`${suffix}${dirty}${primary}`);
      }
      return cardReply("Workspace 状态", lines, {
        sections: [{ title: "仓库", lines: repoLines }],
      });
    } else {
      lines.push("- 仓库：0");
    }
    return cardReply("Workspace 状态", lines);
  },
};

const syncHandler: CommandHandler = {
  name: "sync",
  description: "/sync — 对当前 workspace 下的每个仓库 fetch + 快进拉取",
  async execute(ctx) {
    const chatId = requireChatId(ctx);
    const resolution = ctx.workspaceStore.resolve(chatId ?? null);
    if (!resolution.binding && chatId) {
      return "ℹ️  当前群未绑定 workspace；先执行 `/setup` 或 `/bind` 再 `/sync`。";
    }
    const workspacePath = resolution.binding?.workspace_path ?? resolution.cwd;
    ctx.logger.info({ workspace_path: workspacePath }, "manual /sync requested");
    const results = await syncWorkspace(workspacePath, { pull: true });
    if (results.length === 0) {
      return cardReply("同步结果", ["ℹ️  当前 workspace 下没有 git 仓库。"]);
    }
    return cardReply("同步结果", [], {
      sections: [{ title: "仓库", lines: results.map(_formatSyncLine) }],
    });
  },
};

const lsHandler: CommandHandler = {
  name: "ls",
  description: "/ls — 列出当前群 workspace 下的所有仓库",
  async execute(ctx) {
    const chatId = requireChatId(ctx);
    const resolution = ctx.workspaceStore.resolve(chatId ?? null);
    const workspacePath = resolution.binding?.workspace_path ?? resolution.cwd;
    const repos = listRepoBasenames(workspacePath);
    if (repos.length === 0) {
      return cardReply("仓库", ["ℹ️  当前 workspace 还没有仓库。"]);
    }
    const primary = resolution.binding?.active_repo;
    const lines: string[] = [];
    for (const name of repos) {
      const mark = name === primary ? " ← 活跃" : "";
      lines.push(`- \`${name}\`${mark}`);
    }
    return cardReply("仓库", [], {
      sections: [{ title: "列表", lines }],
    });
  },
};

const cloneHandler: CommandHandler = {
  name: "clone",
  description: "/clone <git-url> [别名] — 将仓库克隆到当前群的 workspace",
  async execute(ctx) {
    const chatId = requireGroupChat(ctx);
    if (!chatId) {
      if (ctx.message.chat_type === "single") {
        return "❌ /clone 仅在飞书群内可用；单聊请先 `/switch` 到目标 workspace，在群里执行克隆。";
      }
      return "❌ /clone 仅在飞书群内可用。";
    }
    const [url, explicitName] = ctx.args;
    if (!url) return "用法：`/clone <git-url> [别名]`";
    const resolution = ctx.workspaceStore.resolve(chatId);
    const workspacePath = resolution.binding?.workspace_path ?? resolution.cwd;
    // Ensure binding row exists so workspace_path is persisted even before active_repo is picked
    if (!resolution.binding) {
      ctx.workspaceStore.upsertBinding(chatId, {});
    }
    const name = explicitName || deriveRepoName(url);
    const targetPath = join(workspacePath, name);
    if (existsSync(targetPath)) {
      return `❌ workspace 中已存在 \`${name}\`，请换个别名，或使用 \`/ls\` 查看已克隆的仓库。`;
    }
    // If this URL matches a predefined repo in REPOS.md, route the
    // clone through the shared object cache so the history is fetched
    // at most once across all workspaces. Arbitrary URLs still do a
    // plain clone — maintaining a cache entry for a one-off repo
    // isn't worth the bookkeeping.
    const catalogMatch = _findPredefinedByUrl(url);
    const mirror = catalogMatch
      ? await ensureCachedMirror(catalogMatch)
      : null;
    const cloneArgs = mirror
      ? ["clone", "--reference", mirror, url, name]
      : ["clone", url, name];
    ctx.logger.info(
      { chat_id: chatId, url, name, using_cache: Boolean(mirror) },
      "cloning repo",
    );
    const result = await execGit(cloneArgs, workspacePath);
    if (!result.ok) {
      return `❌ \`git clone\` 失败：\n\`\`\`\n${result.stderr || result.stdout}\n\`\`\``;
    }
    return cardReply("克隆完成", [`✅ 已克隆 \`${name}\`.`]);
  },
};

const checkoutHandler: CommandHandler = {
  name: "checkout",
  description: "/checkout <分支> — 切换当前活跃仓库的分支",
  async execute(ctx) {
    const chatId = requireGroupChat(ctx);
    if (!chatId) {
      if (ctx.message.chat_type === "single") {
        return "❌ /checkout 仅在飞书群内可用；单聊共享 workspace 的分支由群侧管理。";
      }
      return "❌ /checkout 仅在飞书群内可用。";
    }
    const [branch] = ctx.args;
    if (!branch) return "用法：`/checkout <分支>`";
    const resolution = ctx.workspaceStore.resolve(chatId);
    if (!resolution.binding?.active_repo) {
      return "❌ 当前群没有活跃仓库。请先执行 `/setup`。";
    }
    const repoPath = join(
      resolution.binding.workspace_path,
      resolution.binding.active_repo,
    );
    // Reject dirty tree so the user can't accidentally drop uncommitted work
    const status = await execGit(["status", "--short"], repoPath);
    if (status.stdout) {
      return `❌ \`${resolution.binding.active_repo}\` 工作区有未提交改动，拒绝切换分支：\n\`\`\`\n${status.stdout}\n\`\`\``;
    }
    const result = await execGit(["checkout", branch], repoPath);
    if (!result.ok) {
      return `❌ \`git checkout ${branch}\` 失败：\n\`\`\`\n${result.stderr || result.stdout}\n\`\`\``;
    }
    ctx.workspaceStore.upsertBinding(chatId, { active_branch: branch });
    return cardReply("切换分支", [
      `✅ \`${resolution.binding.active_repo}\` 已切换到 \`${branch}\``,
    ]);
  },
};

const ungroupHandler: CommandHandler = {
  name: "ungroup",
  description:
    "/ungroup [群名或 chat_id] — 解散机器人创建的群（群内无参=当前群；单聊须指定）",
  async execute(ctx) {
    if (!ctx.message.channel_id) {
      return "❌ /ungroup 需要飞书会话上下文。";
    }
    const channel = ctx.feishuChannels.get(ctx.message.channel_id);
    if (!channel) {
      return "❌ 找不到对应的飞书 channel。";
    }
    const senderOpenId = ctx.message.sender_open_id;
    if (!senderOpenId) {
      return "❌ 无法识别发命令的用户。";
    }
    const isP2P = ctx.message.chat_type === "single";

    // Decide which chat to dismiss.
    let targetChatId: string;
    let targetName: string;
    if (isP2P) {
      const query = ctx.args.join(" ").trim();
      if (!query) {
        return "用法：`/ungroup <群名或 chat_id>`（单聊内必须指定目标）";
      }
      const matches = channel.findBotGroupForCreator(query, senderOpenId);
      if (matches.length === 0) {
        return `❌ 没有找到你创建的群匹配 \`${query}\`。`;
      }
      if (matches.length > 1) {
        const idList = matches
          .map((m) => `- \`${m.chat_name}\` (\`${m.chat_id}\`)`)
          .join("\n");
        return `⚠️  有多个同名群，请用 chat_id 指定：\n${idList}`;
      }
      targetChatId = matches[0]!.chat_id;
      targetName = matches[0]!.chat_name;
    } else {
      const chatId = ctx.message.chat_id;
      if (!chatId) return "❌ 无法获取当前群 chat_id。";
      const row = channel.findBotGroup(chatId);
      if (!row) {
        return "❌ 当前群不是机器人创建的，拒绝解散。";
      }
      if (row.creator_open_id !== senderOpenId) {
        return "🚫 只有当初用 /group 建群的人才能解散它。";
      }
      targetChatId = row.chat_id;
      targetName = row.chat_name;
    }

    try {
      await channel.dismissChat(targetChatId);
    } catch (err) {
      ctx.logger.error(
        { err, chat_id: targetChatId },
        "dismissChat failed",
      );
      return `❌ 解散失败：${(err as Error).message}`;
    }
    channel.deleteBotGroupRecord(targetChatId);
    return cardReply("解散群聊", [
      `✅ 已解散 \`${targetName}\` (\`${targetChatId}\`)。`,
    ]);
  },
};

const allowHandler: CommandHandler = {
  name: "allow",
  description: "/allow @user1 @user2 ... — 把 @ 的人加到机器人白名单",
  async execute(ctx) {
    if (!ctx.message.channel_id) {
      return "❌ /allow 需要飞书会话上下文。";
    }
    const channel = ctx.feishuChannels.get(ctx.message.channel_id);
    if (!channel) {
      return "❌ 找不到对应的飞书 channel。";
    }
    const senderOpenId = ctx.message.sender_open_id;
    if (!senderOpenId) {
      return "❌ 无法识别发命令的用户。";
    }
    const mentions = ctx.message.mentions ?? [];
    // Self-mention doesn't count — adding yourself is a no-op since you
    // clearly already passed the whitelist gate to get here.
    const targets = Array.from(
      new Set(
        mentions
          .map((m) => m.open_id)
          .filter((id) => id && id !== senderOpenId),
      ),
    );
    if (targets.length === 0) {
      return "用法：`/allow @user1 @user2 ...`（至少 @ 一个人，不能 @ 自己）";
    }
    let added: string[];
    try {
      added = await channel.addToWhitelist(targets, senderOpenId);
    } catch (err) {
      ctx.logger.error({ err, targets }, "addToWhitelist failed");
      return `❌ 写入白名单失败：${(err as Error).message}`;
    }
    if (added.length === 0) {
      return "ℹ️  所有指定用户已在白名单里，无需更新。";
    }
    return cardReply("白名单已更新", [
      `✅ 新增 ${added.length} 人到白名单：`,
      ...added.map((id) => `- \`${id}\``),
    ]);
  },
};

/**
 * Toggle "auto respond" on the current thread. Default (muted) is must-@:
 * inside a bot-created thread the bot still requires @-mention to reply,
 * so humans can use the same thread to discuss with each other without
 * the bot jumping in. `/unmute` flips the thread into auto-respond mode;
 * `/mute` restores the default.
 */
function buildMuteHandler(
  name: "mute" | "unmute",
  description: string,
  enabled: boolean,
): CommandHandler {
  const verb = enabled ? "解除静音" : "静音";
  const stateLine = enabled
    ? "✅ 已取消静音：本话题内的消息无需 @ 机器人也会响应。"
    : "✅ 已静音：本话题内需要 @ 机器人后才会响应。";
  return {
    name,
    description,
    async execute(ctx) {
      if (ctx.message.chat_type !== "group") {
        return `❌ /${name} 仅在群聊话题内可用（单聊本就不需要 @）。`;
      }
      const threadId = ctx.message.thread_id;
      if (!threadId) {
        return `❌ /${name} 需要在一个话题里执行；请在机器人发起的话题内回复此命令。`;
      }
      if (!ctx.message.channel_id) {
        return `❌ /${name} 需要飞书会话上下文。`;
      }
      const channel = ctx.feishuChannels.get(ctx.message.channel_id);
      if (!channel) {
        return "❌ 找不到对应的飞书 channel。";
      }
      channel.setThreadAutoRespond(threadId, enabled, ctx.message.session_id);
      ctx.logger.info(
        {
          thread_id: threadId,
          session_id: ctx.message.session_id,
          auto_respond: enabled,
        },
        "thread auto-respond toggled",
      );
      return cardReply(verb, [stateLine]);
    },
  };
}

const muteHandler = buildMuteHandler(
  "mute",
  "/mute — 关闭本话题的免 @ 自动响应（恢复默认：必须 @ 机器人）",
  false,
);

const unmuteHandler = buildMuteHandler(
  "unmute",
  "/unmute — 开启本话题的免 @ 自动响应（机器人自动接话）",
  true,
);

export const helpHandler: CommandHandler = {
  name: "help",
  description: "/help — 显示所有可用命令",
  async execute() {
    return cardReply("可用命令", [], {
      sections: [
        {
          title: "命令",
          lines: [
            ...BUILTIN_COMMANDS.map((h) => `- ${h.description}`),
            "- /help — 显示本消息",
            "- /stop — 取消当前 session 正在执行的任务",
            "- /setting — 打开设置面板（全局配置 + workspace 管理）",
            "- /workspaces — 打开设置面板（快捷入口，等价于 /setting）",
            "- /setup — 打开 workspace 配置卡片（仅群聊）",
            "- /switch — 打开 workspace 切换卡片（群聊 & 单聊）",
            "- /group <群名> @user... — 机器人建群并自动 /setup（仅单聊）",
            "- /new <消息> — 开启新会话 + 新话题（须在主群，非话题内）",
          ],
        },
      ],
    });
  },
};

export const BUILTIN_COMMANDS: CommandHandler[] = [
  agentHandler,
  agentsHandler,
  bindHandler,
  unbindHandler,
  statusHandler,
  syncHandler,
  lsHandler,
  cloneHandler,
  checkoutHandler,
  ungroupHandler,
  allowHandler,
  muteHandler,
  unmuteHandler,
];

function _formatSyncLine(r: RepoSyncResult): string {
  const label = `\`${formatRepoRef(r.name, r.branch)}\``;
  const ab = formatAheadBehind(r.ahead, r.behind);
  const abSuffix = ab ? ` ${ab}` : "";
  switch (r.status) {
    case "up_to_date":
      return `- ✅ ${label}${abSuffix}`;
    case "fast_forwarded":
      return (
        `- ⬇️ ${label} 已快进${abSuffix}` +
        (r.before_sha && r.after_sha
          ? `：${r.before_sha} → ${r.after_sha}`
          : "")
      );
    case "no_upstream":
      return `- ℹ️  ${label} 无 upstream`;
    case "detached":
      return `- ⚠️  ${r.name} 处于 detached HEAD${abSuffix}`;
    case "skipped_dirty":
      return `- 🚧 ${label}${abSuffix} 工作区有未提交改动，跳过拉取`;
    case "skipped_diverged":
      return `- 🚧 ${label}${abSuffix} 本地与 upstream 分叉，跳过快进拉取`;
    case "fetch_failed":
      return `- ❌ ${label} fetch 失败${r.detail ? `：${r.detail}` : ""}`;
    case "pull_failed":
      return `- ❌ ${label}${abSuffix} pull 失败${r.detail ? `：${r.detail}` : ""}`;
  }
}

function listRepoBasenames(workspacePath: string): string[] {
  if (!existsSync(workspacePath)) return [];
  try {
    return readdirSync(workspacePath)
      .filter((name) => !name.startsWith("."))
      .filter((name) => {
        const p = join(workspacePath, name);
        try {
          return statSync(p).isDirectory() && existsSync(join(p, ".git"));
        } catch {
          return false;
        }
      })
      .sort();
  } catch {
    return [];
  }
}

function deriveRepoName(url: string): string {
  let tail = url.trim();
  if (tail.endsWith("/")) tail = tail.slice(0, -1);
  const last = basename(tail);
  return last.endsWith(".git") ? last.slice(0, -4) : last;
}

/**
 * Look up a predefined repo by its git URL, normalizing trailing `.git`
 * and `/` so users copy-pasting the URL without the `.git` suffix still
 * hit the cache. Returns `null` when the URL isn't in REPOS.md.
 */
function _findPredefinedByUrl(
  url: string,
): { name: string; git_url: string } | null {
  const norm = _normalizeGitUrl(url);
  for (const repo of loadPredefinedRepos()) {
    if (_normalizeGitUrl(repo.git_url) === norm) return repo;
  }
  return null;
}

function _normalizeGitUrl(url: string): string {
  let u = url.trim().toLowerCase();
  if (u.endsWith("/")) u = u.slice(0, -1);
  if (u.endsWith(".git")) u = u.slice(0, -4);
  return u;
}
