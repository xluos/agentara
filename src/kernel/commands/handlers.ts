import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

import type { CommandContext, CommandHandler } from "./types";

/**
 * Non-LLM commands that run inside `_handleInboundMessage` before the
 * TaskDispatcher. All commands are scoped to the current Feishu `chat_id`
 * unless noted. Missing `chat_id` means the message came from a source
 * that doesn't support group bindings; we reject those commands politely.
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
  description: "/bind <repo> <branch> — bind current group to a repo + branch",
  async execute(ctx) {
    const chatId = requireChatId(ctx);
    if (!chatId) return "❌ /bind requires a Feishu group context.";
    const [repo, branch] = ctx.args;
    if (!repo || !branch) {
      return "Usage: `/bind <repo-dir-basename> <branch>`\nHint: clone first via `/clone <git-url>`.";
    }
    const resolution = ctx.workspaceStore.resolve(chatId);
    const workspacePath = resolution.binding?.workspace_path ?? resolution.cwd;
    const repoPath = join(workspacePath, repo);
    if (!existsSync(repoPath) || !existsSync(join(repoPath, ".git"))) {
      return `❌ \`${repo}\` not found under workspace \`${workspacePath}\`. Run \`/clone <git-url>\` first, or check \`/ls\`.`;
    }
    const checkout = await execGit(["checkout", branch], repoPath);
    if (!checkout.ok) {
      return `❌ \`git checkout ${branch}\` failed:\n\`\`\`\n${checkout.stderr || checkout.stdout}\n\`\`\``;
    }
    const binding = ctx.workspaceStore.upsertBinding(chatId, {
      active_repo: repo,
      active_branch: branch,
    });
    ctx.logger.info({ chat_id: chatId, binding }, "group binding updated");
    return [
      `✅ Bound group to \`${repo}\` @ \`${branch}\``,
      `Workspace: \`${binding.workspace_path}\``,
      `Next messages will use this repo+branch until \`/unbind\` or another \`/bind\`.`,
    ].join("\n");
  },
};

const unbindHandler: CommandHandler = {
  name: "unbind",
  description: "/unbind — clear this group's binding (fall back to default workspace)",
  async execute(ctx) {
    const chatId = requireChatId(ctx);
    if (!chatId) return "❌ /unbind requires a Feishu group context.";
    const removed = ctx.workspaceStore.deleteBinding(chatId);
    if (!removed) return "ℹ️  This group is not bound.";
    return "✅ Group binding cleared. Future messages will use the default workspace.";
  },
};

const statusHandler: CommandHandler = {
  name: "status",
  description: "/status — show current group binding + cloned repos",
  async execute(ctx) {
    const chatId = requireChatId(ctx);
    if (!chatId) {
      return [
        "ℹ️  No Feishu group context — running on the default workspace.",
        `Default: \`${ctx.workspaceStore.resolve(null).cwd}\``,
      ].join("\n");
    }
    const resolution = ctx.workspaceStore.resolve(chatId);
    const lines: string[] = [];
    if (!resolution.binding) {
      lines.push("ℹ️  This group is **not bound**.");
      lines.push(`Default workspace: \`${resolution.cwd}\``);
      lines.push("Use `/bind <repo> <branch>` or `/clone <url>` to set up.");
      return lines.join("\n");
    }
    lines.push("**Group binding:**");
    lines.push(`- Workspace: \`${resolution.binding.workspace_path}\``);
    lines.push(`- Active repo: \`${resolution.binding.active_repo ?? "(none)"}\``);
    lines.push(`- Active branch: \`${resolution.binding.active_branch ?? "(none)"}\``);
    const repos = listRepoBasenames(resolution.binding.workspace_path);
    if (repos.length > 0) {
      lines.push("", "**Cloned repos in workspace:**");
      for (const name of repos) lines.push(`- \`${name}\``);
    } else {
      lines.push("", "_Workspace has no cloned repos yet._");
    }
    if (ctx.message.thread_id) {
      lines.push("", `**This topic's session:** \`${ctx.message.session_id}\``);
    }
    return lines.join("\n");
  },
};

const lsHandler: CommandHandler = {
  name: "ls",
  description: "/ls — list cloned repos in current group's workspace",
  async execute(ctx) {
    const chatId = requireChatId(ctx);
    const resolution = ctx.workspaceStore.resolve(chatId ?? null);
    const workspacePath = resolution.binding?.workspace_path ?? resolution.cwd;
    const repos = listRepoBasenames(workspacePath);
    if (repos.length === 0) {
      return `_No repos under \`${workspacePath}\`. Use \`/clone <git-url>\` to add one._`;
    }
    const primary = resolution.binding?.active_repo;
    const lines = [`**Repos in \`${workspacePath}\`:**`];
    for (const name of repos) {
      const mark = name === primary ? " ← active" : "";
      lines.push(`- \`${name}\`${mark}`);
    }
    return lines.join("\n");
  },
};

const cloneHandler: CommandHandler = {
  name: "clone",
  description: "/clone <git-url> [name] — clone a repo into current group's workspace",
  async execute(ctx) {
    const chatId = requireChatId(ctx);
    if (!chatId) return "❌ /clone requires a Feishu group context.";
    const [url, explicitName] = ctx.args;
    if (!url) return "Usage: `/clone <git-url> [name]`";
    const resolution = ctx.workspaceStore.resolve(chatId);
    const workspacePath = resolution.binding?.workspace_path ?? resolution.cwd;
    // Ensure binding row exists so workspace_path is persisted even before active_repo is picked
    if (!resolution.binding) {
      ctx.workspaceStore.upsertBinding(chatId, {});
    }
    const name = explicitName || deriveRepoName(url);
    const targetPath = join(workspacePath, name);
    if (existsSync(targetPath)) {
      return `❌ \`${name}\` already exists in workspace. Choose a different name or \`/ls\` to inspect.`;
    }
    ctx.logger.info({ chat_id: chatId, url, name }, "cloning repo");
    const result = await execGit(["clone", url, name], workspacePath);
    if (!result.ok) {
      return `❌ \`git clone\` failed:\n\`\`\`\n${result.stderr || result.stdout}\n\`\`\``;
    }
    return [
      `✅ Cloned \`${name}\` into workspace.`,
      `Use \`/bind ${name} <branch>\` to make it the active repo for this group.`,
    ].join("\n");
  },
};

const checkoutHandler: CommandHandler = {
  name: "checkout",
  description: "/checkout <branch> — switch the active repo's branch",
  async execute(ctx) {
    const chatId = requireChatId(ctx);
    if (!chatId) return "❌ /checkout requires a Feishu group context.";
    const [branch] = ctx.args;
    if (!branch) return "Usage: `/checkout <branch>`";
    const resolution = ctx.workspaceStore.resolve(chatId);
    if (!resolution.binding?.active_repo) {
      return "❌ No active repo. Run `/bind <repo> <branch>` first.";
    }
    const repoPath = join(
      resolution.binding.workspace_path,
      resolution.binding.active_repo,
    );
    // Reject dirty tree so the user can't accidentally drop uncommitted work
    const status = await execGit(["status", "--short"], repoPath);
    if (status.stdout) {
      return `❌ Dirty tree in \`${resolution.binding.active_repo}\`, refusing to checkout.\n\`\`\`\n${status.stdout}\n\`\`\``;
    }
    const result = await execGit(["checkout", branch], repoPath);
    if (!result.ok) {
      return `❌ \`git checkout ${branch}\` failed:\n\`\`\`\n${result.stderr || result.stdout}\n\`\`\``;
    }
    ctx.workspaceStore.upsertBinding(chatId, { active_branch: branch });
    return `✅ \`${resolution.binding.active_repo}\` is now on branch \`${branch}\`.`;
  },
};

export const helpHandler: CommandHandler = {
  name: "help",
  description: "/help — show available commands",
  async execute() {
    return [
      "**Gateway commands (bypass LLM):**",
      ...BUILTIN_COMMANDS.map((h) => `- ${h.description}`),
      "- /help — this message",
      "- /stop — cancel the running task in this session",
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
