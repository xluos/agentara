import { existsSync } from "node:fs";
import { join } from "node:path";

import type { Logger } from "@/shared";
import {
  config,
  createLogger,
  loadPredefinedRepos,
  type CardActionPayload,
  type PredefinedRepo,
  type UserMessage,
} from "@/shared";

import type { FeishuMessageChannel } from "../../community/feishu/messaging/message-channel";
import type { GroupWorkspaceStore } from "../workspaces";

import {
  buildSetupCard,
  buildSetupResultCard,
  SETUP_FIELD,
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
   * text is `/setup`. Sends back either a plain-text error (no catalog,
   * already bound, ...) or the interactive card.
   */
  async start(message: UserMessage): Promise<void> {
    const chatId = message.chat_id;
    if (!chatId || !message.channel_id) {
      await this._replyText(message, "❌ /setup 仅在飞书群内可用。");
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
    const existing = this._workspaceStore.getBinding(chatId);
    if (existing) {
      const repo = existing.active_repo ?? "(未设置)";
      const branch = existing.active_branch ?? "(未设置)";
      await this._replyText(
        message,
        `❌ 当前群已绑定 \`${repo}\` @ \`${branch}\`，请先 \`/unbind\`。`,
      );
      return;
    }
    const channel = this._feishuChannels.get(message.channel_id);
    if (!channel) {
      await this._replyText(message, "❌ 无法找到对应的飞书 channel。");
      return;
    }

    const card = buildSetupCard(catalog);
    const cardMessageId = await channel.sendRawCard(chatId, card, {
      replyTo: message.id,
    });
    this._pending.set(cardMessageId, {
      chat_id: chatId,
      initiator_open_id: message.sender_open_id ?? "",
      catalog_snapshot: catalog,
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
          (s) => `- \`${s.name}\` @ \`${s.branch}\``,
        ),
      ),
      "pending-state",
    );

    const workspacePath = config.paths.resolveGroupWorkspacePath(
      pending.chat_id,
    );
    if (!existsSync(workspacePath)) {
      const { mkdirSync } = await import("node:fs");
      mkdirSync(workspacePath, { recursive: true });
    }

    const results: RepoResult[] = [];
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

    this._workspaceStore.upsertBinding(pending.chat_id, {
      active_repo: activeRepo,
      active_branch: activeBranch,
    });

    const lines = results.map(_formatResultLine);
    const summary = activeRepo && activeBranch
      ? `✅ 初始化完成，主仓库 \`${activeRepo}\` @ \`${activeBranch}\`。`
      : "❌ 所有仓库克隆失败，未建立绑定。";
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
  ): Array<{ repo: PredefinedRepo; name: string; branch: string }> {
    const out: Array<{ repo: PredefinedRepo; name: string; branch: string }> =
      [];
    for (const repo of catalog) {
      const rawChecked = formValue[SETUP_FIELD.repoChecker(repo.name)];
      if (!_isTruthyChecker(rawChecked)) continue;
      const rawBranch = formValue[SETUP_FIELD.branchInput(repo.name)];
      const branch =
        typeof rawBranch === "string" && rawBranch.trim()
          ? rawBranch.trim()
          : "master";
      out.push({ repo, name: repo.name, branch });
    }
    return out;
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
      return `- ✅ \`${r.name}\` @ \`${r.branch}\` 已克隆`;
    case "exists":
      return `- ℹ️  \`${r.name}\` 已存在，已切换到 \`${r.branch}\``;
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
