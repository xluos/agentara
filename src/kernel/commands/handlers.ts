import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

import {
  formatAheadBehind,
  listRepoSyncState,
  syncWorkspace,
  type RepoSyncResult,
} from "@/kernel/workspaces";

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
  return {
    kind: "card",
    card: buildCommandCard({
      title,
      lines,
      sections: options?.sections,
      summary: options?.summary,
    }),
    fallback_text: [title, ...lines].join("\n"),
  };
}

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
        ? `- 活跃仓库：\`${binding.active_repo}${
            binding.active_branch ? " " + binding.active_branch : ""
          }\``
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
    const activeBranch = resolution.binding.active_branch;
    const activeLabel = activeRepo
      ? `\`${activeRepo}${activeBranch ? " " + activeBranch : ""}\``
      : "(未设置)";
    lines.push(`- 活跃仓库：${activeLabel}`);
    const repoStates = listRepoSyncState(resolution.binding.workspace_path);
    if (repoStates.length > 0) {
      const repoLines: string[] = [];
      for (const s of repoStates) {
        const primary = s.name === activeRepo ? " ← 活跃" : "";
        const ahead_behind = formatAheadBehind(s.ahead, s.behind);
        const dirty = s.dirty ? " •" : "";
        const label = s.branch ? `${s.name} ${s.branch}` : s.name;
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
    ctx.logger.info({ chat_id: chatId, url, name }, "cloning repo");
    const result = await execGit(["clone", url, name], workspacePath);
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
            "- /setup — 打开 workspace 配置卡片（仅群聊）",
            "- /switch — 打开 workspace 切换卡片（群聊 & 单聊）",
          ],
        },
      ],
    });
  },
};

export const BUILTIN_COMMANDS: CommandHandler[] = [
  bindHandler,
  unbindHandler,
  statusHandler,
  syncHandler,
  lsHandler,
  cloneHandler,
  checkoutHandler,
];

function _formatSyncLine(r: RepoSyncResult): string {
  const label = r.branch ? `\`${r.name} ${r.branch}\`` : `\`${r.name}\``;
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
