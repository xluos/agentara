import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

import type { CommandContext, CommandHandler } from "./types";

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

const bindHandler: CommandHandler = {
  name: "bind",
  description: "/bind <仓库> <分支> — 绑定当前群到指定仓库和分支",
  async execute(ctx) {
    const chatId = requireChatId(ctx);
    if (!chatId) return "❌ /bind 仅在飞书群内可用。";
    const [repo, branch] = ctx.args;
    if (!repo || !branch) {
      return "用法：`/bind <仓库目录名> <分支>`\n提示：若还未克隆，先用 `/clone <git-url>`。";
    }
    const resolution = ctx.workspaceStore.resolve(chatId);
    const workspacePath = resolution.binding?.workspace_path ?? resolution.cwd;
    const repoPath = join(workspacePath, repo);
    if (!existsSync(repoPath) || !existsSync(join(repoPath, ".git"))) {
      return `❌ 在 workspace 中找不到 \`${repo}\`（\`${workspacePath}\`）。请先 \`/clone <git-url>\`，或用 \`/ls\` 查看已克隆的仓库。`;
    }
    const checkout = await execGit(["checkout", branch], repoPath);
    if (!checkout.ok) {
      return `❌ \`git checkout ${branch}\` 失败：\n\`\`\`\n${checkout.stderr || checkout.stdout}\n\`\`\``;
    }
    const binding = ctx.workspaceStore.upsertBinding(chatId, {
      active_repo: repo,
      active_branch: branch,
    });
    ctx.logger.info({ chat_id: chatId, binding }, "group binding updated");
    return [
      `✅ 已将当前群绑定到 \`${repo}\` @ \`${branch}\``,
      `Workspace：\`${binding.workspace_path}\``,
      `后续消息将使用该仓库和分支，直到再次 \`/bind\` 或 \`/unbind\`。`,
    ].join("\n");
  },
};

const unbindHandler: CommandHandler = {
  name: "unbind",
  description: "/unbind — 清除当前群的绑定（回退到默认 workspace）",
  async execute(ctx) {
    const chatId = requireChatId(ctx);
    if (!chatId) return "❌ /unbind 仅在飞书群内可用。";
    const removed = ctx.workspaceStore.deleteBinding(chatId);
    if (!removed) return "ℹ️  当前群未绑定。";
    return "✅ 群绑定已清除。后续消息将使用默认 workspace。";
  },
};

const statusHandler: CommandHandler = {
  name: "status",
  description: "/status — 查看当前群的绑定及已克隆的仓库",
  async execute(ctx) {
    const chatId = requireChatId(ctx);
    if (!chatId) {
      return [
        "ℹ️  当前不在飞书群上下文，正在使用默认 workspace。",
        `默认路径：\`${ctx.workspaceStore.resolve(null).cwd}\``,
      ].join("\n");
    }
    const resolution = ctx.workspaceStore.resolve(chatId);
    const lines: string[] = [];
    if (!resolution.binding) {
      lines.push("ℹ️  当前群 **未绑定**。");
      lines.push(`默认 workspace：\`${resolution.cwd}\``);
      lines.push("使用 `/bind <仓库> <分支>` 或 `/clone <git-url>` 来初始化。");
      return lines.join("\n");
    }
    lines.push("**当前群绑定：**");
    lines.push(`- Workspace：\`${resolution.binding.workspace_path}\``);
    lines.push(`- 活跃仓库：\`${resolution.binding.active_repo ?? "(未设置)"}\``);
    lines.push(`- 活跃分支：\`${resolution.binding.active_branch ?? "(未设置)"}\``);
    const repos = listRepoBasenames(resolution.binding.workspace_path);
    if (repos.length > 0) {
      lines.push("", "**Workspace 中已克隆的仓库：**");
      for (const name of repos) lines.push(`- \`${name}\``);
    } else {
      lines.push("", "_Workspace 还没有克隆任何仓库。_");
    }
    if (ctx.message.thread_id) {
      lines.push("", `**当前话题的 session：** \`${ctx.message.session_id}\``);
    }
    return lines.join("\n");
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
      return `_\`${workspacePath}\` 下还没有仓库。使用 \`/clone <git-url>\` 添加一个。_`;
    }
    const primary = resolution.binding?.active_repo;
    const lines = [`**\`${workspacePath}\` 下的仓库：**`];
    for (const name of repos) {
      const mark = name === primary ? " ← 活跃" : "";
      lines.push(`- \`${name}\`${mark}`);
    }
    return lines.join("\n");
  },
};

const cloneHandler: CommandHandler = {
  name: "clone",
  description: "/clone <git-url> [别名] — 将仓库克隆到当前群的 workspace",
  async execute(ctx) {
    const chatId = requireChatId(ctx);
    if (!chatId) return "❌ /clone 仅在飞书群内可用。";
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
    return [
      `✅ 已克隆 \`${name}\` 到 workspace。`,
      `使用 \`/bind ${name} <分支>\` 将其设为当前群的活跃仓库。`,
    ].join("\n");
  },
};

const checkoutHandler: CommandHandler = {
  name: "checkout",
  description: "/checkout <分支> — 切换当前活跃仓库的分支",
  async execute(ctx) {
    const chatId = requireChatId(ctx);
    if (!chatId) return "❌ /checkout 仅在飞书群内可用。";
    const [branch] = ctx.args;
    if (!branch) return "用法：`/checkout <分支>`";
    const resolution = ctx.workspaceStore.resolve(chatId);
    if (!resolution.binding?.active_repo) {
      return "❌ 当前群没有活跃仓库。请先执行 `/bind <仓库> <分支>`。";
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
    return `✅ \`${resolution.binding.active_repo}\` 已切换到分支 \`${branch}\`。`;
  },
};

export const helpHandler: CommandHandler = {
  name: "help",
  description: "/help — 显示所有可用命令",
  async execute() {
    return [
      "**可用命令（不经大模型直接执行）：**",
      ...BUILTIN_COMMANDS.map((h) => `- ${h.description}`),
      "- /help — 显示本消息",
      "- /stop — 取消当前 session 正在执行的任务",
    ].join("\n");
  },
};

export const BUILTIN_COMMANDS: CommandHandler[] = [
  bindHandler,
  unbindHandler,
  statusHandler,
  lsHandler,
  cloneHandler,
  checkoutHandler,
];

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
