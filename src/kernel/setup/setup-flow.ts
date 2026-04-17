import { existsSync } from "node:fs";
import { join } from "node:path";

import type { Logger } from "@/shared";
import {
  createLogger,
  loadPredefinedRepos,
  slugifyWorkspaceName,
  type CardActionPayload,
  type GroupWorkspace,
  type PredefinedRepo,
  type UserMessage,
} from "@/shared";

import type { FeishuMessageChannel } from "../../community/feishu/messaging/message-channel";
import type { GroupWorkspaceStore } from "../workspaces";

import {
  buildSetupCard,
  buildSetupResultCard,
  SETUP_FIELD,
  type RepoPrefill,
} from "./setup-card";

/**
 * In-memory pending state for a `/setup` card that has been sent but not
 * yet submitted. Dropped on kernel restart — expired cards surface a clear
 * error back to the user instead of being silently honored.
 */
interface PendingSetup {
  chat_id: string;
  initiator_open_id: string;
  catalog_snapshot: PredefinedRepo[];
  /**
   * Repo names that were already cloned when the card was rendered.
   * Their checkers are disabled on the card, so form submissions may not
   * echo their checked state back — we force-include them on submit.
   */
  locked_repos: Set<string>;
  /** Existing workspace id, when editing an already-bound workspace. */
  locked_workspace_id?: string;
  created_at: number;
}

interface RepoResult {
  name: string;
  /** The branch the user requested in the form. */
  branch: string;
  /**
   * The branch the repo is actually on after clone+checkout. Equal to `branch`
   * on success; on `checkout_failed` it falls back to whatever the clone
   * landed on (the repo's default branch). Unset only on `clone_failed`.
   */
  actual_branch?: string;
  status: "cloned" | "exists" | "clone_failed" | "checkout_failed";
  detail?: string;
}

/**
 * Stateful orchestrator for the `/setup` interactive flow.
 *
 * Lifecycle per invocation:
 * 1. `start(message)` loads the catalog from `REPOS.md`, renders the card,
 *    and remembers the catalog snapshot keyed by the outbound message id.
 * 2. The kernel routes a `card:action` with `action_name === "setup_submit"`
 *    to `handleSubmit(payload)`.
 * 3. The handler clones the selected repos, checks out the requested branches,
 *    upserts the group binding, and replaces the original card with a result
 *    card via `updateRawCard`.
 *
 * Single-writer: all pending-state access stays on this instance. One pending
 * setup per chat is implicit — issuing `/setup` again replaces the key.
 */
export class SetupFlow {
  private readonly _logger: Logger = createLogger("setup-flow");
  private readonly _workspaceStore: GroupWorkspaceStore;
  private readonly _feishuChannels: Map<string, FeishuMessageChannel>;
  private readonly _pending = new Map<string, PendingSetup>();

  constructor(deps: {
    workspaceStore: GroupWorkspaceStore;
    feishuChannels: Map<string, FeishuMessageChannel>;
  }) {
    this._workspaceStore = deps.workspaceStore;
    this._feishuChannels = deps.feishuChannels;
  }

  /**
   * Entry point invoked from `kernel._handleInboundMessage` when the inbound
   * text is `/setup`. Re-runnable: on a second invocation the card renders
   * already-cloned repos as locked checkers with their current branches
   * pre-filled, so the user can add new repos or switch branches without
   * being able to accidentally drop existing ones.
   */
  async start(message: UserMessage): Promise<void> {
    const chatId = message.chat_id;
    if (!chatId || !message.channel_id) {
      await this._replyText(message, "❌ /setup 仅在飞书群内可用。");
      return;
    }
    // P2P is intentionally kept reuse-only — creating workspaces from single
    // chats would produce stray rows keyed to every user's P2P chat_id and
    // make the workspace list hard to reason about. Point users at /switch
    // instead, which lets them bind to any already-existing workspace.
    if (message.chat_type === "single") {
      await this._replyText(
        message,
        "❌ /setup 仅在飞书群内可用；单聊请使用 `/switch` 挑选一个已有 workspace。",
      );
      return;
    }
    const catalog = loadPredefinedRepos();
    if (catalog.length === 0) {
      await this._replyText(
        message,
        "❌ 仓库目录为空，请在 `$AGENTARA_HOME/REPOS.md` 里添加仓库条目（参考文件顶部的示例）。",
      );
      return;
    }
    const channel = this._feishuChannels.get(message.channel_id);
    if (!channel) {
      await this._replyText(message, "❌ 无法找到对应的飞书 channel。");
      return;
    }

    // Re-runs reuse the existing workspace path (locked on the card);
    // first runs propose a slug derived from the group name and let the
    // user customize it. We defer creating the binding/dir until submit.
    const binding = this._workspaceStore.getBinding(chatId);
    const workspaceNameState = await this._resolveWorkspaceNameState(
      chatId,
      binding,
      channel,
    );
    const { prefills, lockedRepos } = binding
      ? this._buildPrefills(binding.workspace_path, catalog)
      : { prefills: {}, lockedRepos: new Set<string>() };

    const card = buildSetupCard(catalog, {
      prefills,
      primary_repo: binding?.active_repo ?? undefined,
      workspace_name: workspaceNameState,
    });
    const cardMessageId = await channel.sendRawCard(chatId, card, {
      replyTo: message.id,
    });
    this._pending.set(cardMessageId, {
      chat_id: chatId,
      initiator_open_id: message.sender_open_id ?? "",
      catalog_snapshot: catalog,
      locked_repos: lockedRepos,
      locked_workspace_id: binding?.workspace_id,
      created_at: Date.now(),
    });
    this._logger.info(
      { chat_id: chatId, card_message_id: cardMessageId },
      "setup card sent",
    );
  }

  /**
   * Entry point invoked from the kernel's `card:action` listener when the
   * payload's `action_name === "setup_submit"`. Looks up the pending state
   * by `payload.message_id` and either rejects the submission (expired,
   * wrong user, invalid selection) or runs the clone+bind sequence.
   */
  async handleSubmit(payload: CardActionPayload): Promise<void> {
    const channel = this._feishuChannels.get(payload.channel_id);
    if (!channel) {
      this._logger.warn(
        { channel_id: payload.channel_id },
        "received card action for unknown channel",
      );
      return;
    }
    const pending = this._pending.get(payload.message_id);
    if (!pending) {
      await this._tryUpdateCard(
        channel,
        payload.message_id,
        buildSetupResultCard(
          "⚠️  这张卡片已失效，请重新发送 `/setup`。",
          [],
        ),
        "expired",
      );
      return;
    }
    if (
      pending.initiator_open_id &&
      payload.operator_open_id !== pending.initiator_open_id
    ) {
      await this._tryUpdateCard(
        channel,
        payload.message_id,
        buildSetupResultCard("🚫 这不是你的表单。", []),
        "non-initiator",
      );
      return;
    }

    this._pending.delete(payload.message_id);

    const selections = this._parseFormValue(
      payload.form_value,
      pending.catalog_snapshot,
      pending.locked_repos,
    );
    if (selections.length === 0) {
      await this._tryUpdateCard(
        channel,
        payload.message_id,
        buildSetupResultCard("⚠️  未选择任何仓库，请重新发送 `/setup`。", []),
        "empty-selection",
      );
      return;
    }

    const rawPrimary =
      typeof payload.form_value[SETUP_FIELD.primaryRepo] === "string"
        ? (payload.form_value[SETUP_FIELD.primaryRepo] as string)
        : "";
    // `selections` is guaranteed non-empty by the earlier length-check return.
    const firstSel = selections[0]!;
    const primary = selections.find((s) => s.name === rawPrimary)
      ? rawPrimary
      : firstSel.name;

    // Swap the card to a "working" state immediately so the user sees that
    // the submit landed, then run clones (possibly long) before the final
    // update. If this patch fails, we still proceed to the clone work.
    await this._tryUpdateCard(
      channel,
      payload.message_id,
      buildSetupResultCard(
        `⏳ 正在初始化 \`${selections.map((s) => s.name).join("、")}\`…`,
        selections.map(
          (s) => `- \`${s.name} ${s.branch}\``,
        ),
      ),
      "pending-state",
    );

    // Workspace name is a pure display label — freely editable on every
    // run. The directory path is derived from the stable workspace id by
    // the store, so changing the name never moves files on disk. We resolve
    // the requested name here and pass it through; the store's mutation
    // path decides whether to create a new workspace or rename an existing
    // one. The old `workspace_path` hint is no longer useful.
    const workspaceName = this._resolveWorkspaceNameFromForm(
      payload.form_value[SETUP_FIELD.workspaceName],
      pending.chat_id,
    );

    const results: RepoResult[] = [];
    const provisionalBinding = this._workspaceStore.upsertBinding(
      pending.chat_id,
      {
        workspace_id: pending.locked_workspace_id,
        workspace_name: workspaceName,
      },
    );
    const workspacePath = provisionalBinding.workspace_path;
    for (const sel of selections) {
      results.push(await this._cloneAndCheckout(workspacePath, sel));
    }

    const primaryResult = results.find((r) => r.name === primary);
    // active_branch comes from `actual_branch`, which is always set unless the
    // clone itself failed. If the requested branch didn't exist, we bind to
    // whatever the clone landed on (usually the remote HEAD) instead of null.
    const activeRepo =
      primaryResult && primaryResult.status !== "clone_failed" ? primary : null;
    const activeBranch = primaryResult?.actual_branch ?? null;

    const binding = this._workspaceStore.upsertBinding(pending.chat_id, {
      active_repo: activeRepo,
      active_branch: activeBranch,
    });

    const lines = [
      `- Workspace ID: \`${binding.workspace_id}\``,
      `- Workspace 名称: \`${binding.workspace_name}\``,
      `- Workspace 路径: \`${binding.workspace_path}\``,
      "- 其他群可用 `/bind <workspace-id>` 复用这个空间。",
      ...results.map(_formatResultLine),
    ];
    const summary = activeRepo && activeBranch
      ? `✅ 初始化完成，主仓库 \`${activeRepo} ${activeBranch}\`。`
      : "⚠️  workspace 已创建，但这次没有成功设置主仓库。";
    await this._tryUpdateCard(
      channel,
      payload.message_id,
      buildSetupResultCard(summary, lines),
      "final-result",
    );
    this._logger.info(
      {
        chat_id: pending.chat_id,
        primary,
        results: results.map((r) => ({ name: r.name, status: r.status })),
      },
      "setup submit completed",
    );
  }

  /**
   * `updateRawCard` wrapper that logs the Feishu error body instead of
   * crashing the handleSubmit flow. On failure we press on — the user at
   * least knows clone ran from logs, even if the UI card is stuck.
   */
  private async _tryUpdateCard(
    channel: FeishuMessageChannel,
    messageId: string,
    card: ReturnType<typeof buildSetupResultCard>,
    stage: string,
  ): Promise<void> {
    try {
      await channel.updateRawCard(messageId, card);
    } catch (err) {
      const detail = _summarizeFeishuError(err);
      this._logger.error(
        { err: detail, stage, message_id: messageId },
        "updateRawCard failed",
      );
    }
  }

  private _parseFormValue(
    formValue: Record<string, unknown>,
    catalog: PredefinedRepo[],
    lockedRepos: Set<string>,
  ): Array<{ repo: PredefinedRepo; name: string; branch: string }> {
    const out: Array<{ repo: PredefinedRepo; name: string; branch: string }> =
      [];
    for (const repo of catalog) {
      const rawChecked = formValue[SETUP_FIELD.repoChecker(repo.name)];
      // Locked repos are rendered with disabled checkers — some Feishu
      // clients don't echo disabled values back, so force-include them.
      const isSelected =
        lockedRepos.has(repo.name) || _isTruthyChecker(rawChecked);
      if (!isSelected) continue;
      const rawBranch = formValue[SETUP_FIELD.branchInput(repo.name)];
      const branch =
        typeof rawBranch === "string" && rawBranch.trim()
          ? rawBranch.trim()
          : "master";
      out.push({ repo, name: repo.name, branch });
    }
    return out;
  }

  /**
   * Build the workspace-name input's pre-fill + lock state.
   *
   * - Re-run (binding exists): the current directory basename is locked in
   *   and the stable workspace id is surfaced too, so the user can copy it
   *   out and run `/bind <id>` from another group.
   * - First run: try to fetch the Feishu group name; slugify it and append
   *   `-workspace` to produce a human-readable default. If the group name
   *   is unavailable or sluggifies to nothing, fall back to a chat-id
   *   prefix so the input never starts empty.
   */
  private async _resolveWorkspaceNameState(
    chatId: string,
    binding: GroupWorkspace | null,
    channel: FeishuMessageChannel,
  ): Promise<{ value: string; locked: boolean; id?: string }> {
    if (binding) {
      return {
        value: binding.workspace_name,
        locked: true,
        id: binding.workspace_id,
      };
    }
    const groupName = await channel.getChatName(chatId);
    const slug = groupName ? slugifyWorkspaceName(groupName) : "";
    const fallback = _chatIdFallbackSlug(chatId);
    const value = slug ? `${slug}-workspace` : `${fallback}-workspace`;
    return { value, locked: false };
  }

  /**
   * Resolve the workspace path from the form's `workspace_name` field on
   * first-run submission. Sluggifies whatever the user typed; if nothing
   * usable survives (empty/whitespace-only input), falls back to the
   * chat-id-based path so we never write a binding with an empty name.
   */
  private _resolveWorkspaceNameFromForm(
    rawValue: unknown,
    chatId: string,
  ): string {
    const slug =
      typeof rawValue === "string" ? slugifyWorkspaceName(rawValue) : "";
    if (slug) return slug;
    return _chatIdFallbackSlug(chatId);
  }

  /**
   * Compute per-repo pre-fill state for the card: which catalog repos are
   * already cloned in this workspace and what branch each is currently on.
   * The set of locked repo names is tracked so the submit handler can
   * force-include them even if the card's disabled checker swallows the
   * checked state.
   */
  private _buildPrefills(
    workspacePath: string,
    catalog: PredefinedRepo[],
  ): { prefills: Record<string, RepoPrefill>; lockedRepos: Set<string> } {
    const prefills: Record<string, RepoPrefill> = {};
    const lockedRepos = new Set<string>();
    for (const repo of catalog) {
      const repoPath = join(workspacePath, repo.name);
      if (!existsSync(join(repoPath, ".git"))) continue;
      lockedRepos.add(repo.name);
      prefills[repo.name] = {
        already_cloned: true,
        current_branch: _readCurrentBranch(repoPath),
      };
    }
    return { prefills, lockedRepos };
  }

  private async _cloneAndCheckout(
    workspacePath: string,
    sel: { repo: PredefinedRepo; name: string; branch: string },
  ): Promise<RepoResult> {
    const targetPath = join(workspacePath, sel.name);
    const alreadyCloned = existsSync(join(targetPath, ".git"));

    if (!alreadyCloned) {
      const clone = await _execGit(
        ["clone", sel.repo.git_url, sel.name],
        workspacePath,
      );
      if (!clone.ok) {
        return {
          name: sel.name,
          branch: sel.branch,
          status: "clone_failed",
          detail: clone.stderr || clone.stdout,
        };
      }
    } else {
      // Fetch so `git checkout <new-branch>` can find branches pushed after
      // the initial clone. Fetch failures are non-fatal — if the user only
      // wants to switch between already-known branches, offline is fine.
      const fetch = await _execGit(
        ["fetch", "--prune", "origin"],
        targetPath,
      );
      if (!fetch.ok) {
        this._logger.warn(
          { repo: sel.name, stderr: fetch.stderr },
          "git fetch failed before checkout; continuing with stale refs",
        );
      }
    }

    const co = await _execGit(["checkout", sel.branch], targetPath);
    if (!co.ok) {
      // Fall back to the branch the repo is currently on so the binding still
      // has an `active_branch` instead of leaving it blank.
      const head = await _execGit(
        ["rev-parse", "--abbrev-ref", "HEAD"],
        targetPath,
      );
      const fallbackBranch = head.ok && head.stdout ? head.stdout : sel.branch;
      return {
        name: sel.name,
        branch: sel.branch,
        actual_branch: fallbackBranch,
        status: "checkout_failed",
        detail: co.stderr || co.stdout,
      };
    }

    // After a successful checkout on an already-cloned repo, try a
    // fast-forward pull so users who re-run /setup without changing the
    // branch still get the latest commits. `--ff-only` refuses on dirty
    // trees or divergence, which keeps this safe to run unconditionally.
    if (alreadyCloned) {
      const pull = await _execGit(
        ["pull", "--ff-only", "--no-rebase"],
        targetPath,
      );
      if (!pull.ok) {
        this._logger.info(
          { repo: sel.name, stderr: pull.stderr },
          "ff-only pull skipped/failed; leaving at current commit",
        );
      }
    }

    return {
      name: sel.name,
      branch: sel.branch,
      actual_branch: sel.branch,
      status: alreadyCloned ? "exists" : "cloned",
    };
  }

  private async _replyText(
    message: UserMessage,
    text: string,
  ): Promise<void> {
    if (!message.channel_id) return;
    const channel = this._feishuChannels.get(message.channel_id);
    if (!channel) return;
    await channel.replyMessage(
      message.id,
      {
        role: "assistant",
        session_id: message.session_id,
        content: [{ type: "text", text }],
      },
      { streaming: false, replyInThread: false },
    );
  }
}

function _isTruthyChecker(v: unknown): boolean {
  if (v === true) return true;
  if (typeof v === "string") {
    const lower = v.toLowerCase();
    return lower === "true" || lower === "1" || lower === "on";
  }
  return false;
}

function _formatResultLine(r: RepoResult): string {
  switch (r.status) {
    case "cloned":
      return `- ✅ \`${r.name} ${r.branch}\` 已克隆`;
    case "exists":
      return `- ℹ️  \`${r.name} ${r.branch}\` 已存在`;
    case "checkout_failed":
      return (
        `- ⚠️  \`${r.name}\` 已克隆，分支 \`${r.branch}\` 不可切换，` +
        `保留在 \`${r.actual_branch ?? "(未知)"}\`` +
        (r.detail ? `：${_compressDetail(r.detail)}` : "")
      );
    case "clone_failed":
      return `- ❌ \`${r.name}\` 克隆失败${
        r.detail ? `：${_compressDetail(r.detail)}` : ""
      }`;
  }
}

function _compressDetail(detail: string): string {
  const first = detail.split("\n").find((l) => l.trim()) ?? "";
  return first.length > 120 ? first.slice(0, 120) + "…" : first;
}

/**
 * Extract the useful bits out of a Feishu/Axios error so we can see the
 * actual server error code + message in the logs without dumping the whole
 * request/response graph.
 */
function _summarizeFeishuError(
  err: unknown,
): { code?: number; msg?: string; status?: number; raw?: unknown } {
  if (!err || typeof err !== "object") {
    return { raw: err };
  }
  const candidate = err as {
    response?: {
      status?: number;
      data?: { code?: number; msg?: string };
    };
    message?: string;
  };
  return {
    code: candidate.response?.data?.code,
    msg: candidate.response?.data?.msg ?? candidate.message,
    status: candidate.response?.status,
  };
}

/**
 * Readable-ish short form of a Feishu chat id — used when the group name
 * is unavailable so the default workspace name is still unique + stable.
 * Strips the `oc_` prefix (always present on chat ids) and keeps the first
 * 8 chars of the opaque suffix.
 */
function _chatIdFallbackSlug(chatId: string): string {
  const stripped = chatId.replace(/^oc_/, "");
  return stripped.slice(0, 8) || "group";
}

function _readCurrentBranch(repoPath: string): string | undefined {
  try {
    const proc = Bun.spawnSync(
      ["git", "rev-parse", "--abbrev-ref", "HEAD"],
      { cwd: repoPath, stdout: "pipe", stderr: "pipe" },
    );
    if (proc.exitCode !== 0) return undefined;
    const out = proc.stdout.toString().trim();
    return out && out !== "HEAD" ? out : undefined;
  } catch {
    return undefined;
  }
}

async function _execGit(
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
