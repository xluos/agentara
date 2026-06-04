import {
  contextLimitForModel,
  getClaudeUsageCached,
} from "@/community/anthropic";
import { FeishuMessageChannel } from "@/community/feishu";
import * as feishuMessagingSchema from "@/community/feishu/messaging/data";
import type { Card } from "@/community/feishu/messaging/types";
import { CodexMissingResumeError } from "@/community/openai";
import { DataConnection } from "@/data";
// Side-effect import: every module under `src/plugins/*` registers its
// runner with the registry at load time. This must happen before any
// session dispatch so `agents.default.type` can resolve plugin types.
import "@/plugins";
import type {
  AssistantMessage,
  CardActionPayload,
  CardFooterStats,
  Session as SessionEntity,
  UserMessage,
} from "@/shared";
import {
  config,
  createLogger,
  extractTextContent,
  uuid,
  type InboundMessageTaskPayload,
  type ScheduledTaskPayload,
} from "@/shared";

import { HonoServer } from "../server";

import {
  buildAgentCancelledContent,
  buildAgentFailureContent,
} from "./agent-failure";
import {
  buildCodexResumeExpiredCard,
  buildCodexResumeMissingCard,
  buildCodexResumeRestartedCard,
  buildCodexResumeRestartingCard,
  CODEX_RESUME_RESTART_ACTION,
  formatCodexResumeMissingText,
} from "./codex-resume-card";
import {
  buildNewCommandRejectionReply,
  buildNewCommandUsageReply,
  buildUnknownCommandReply,
  CommandRegistry,
  isPassthroughCommand,
  createFreshUserMessage,
  extractNewPrompt,
  isNewCommand,
  parseCommand,
  type CardCommandResult,
  type DeferredCardCommandResult,
} from "./commands";
import { buildCommandCard } from "./commands/cards";
import { GroupFlow } from "./group/group-flow";
import { MultiChannelMessageGateway } from "./messaging";
import { PERMISSION_ACTION, PermissionFlow, QUESTION_ACTION } from "./permission";
import { ReposFlow } from "./repos";
import { readLatestSessionUsageSnapshot, SessionManager } from "./sessioning";
import * as sessioningSchema from "./sessioning/data";
import { SettingFlow } from "./setting/setting-flow";
import { SETUP_DISMISS_ACTION } from "./setup/setup-card";
import { SetupFlow } from "./setup/setup-flow";
import { SwitchFlow } from "./setup/switch-flow";
import { TaskDispatcher } from "./tasking";
import * as taskingSchema from "./tasking/data";
import { GroupWorkspaceStore, syncWorkspace } from "./workspaces";

const AUTO_COMPACT_TOKEN_THRESHOLD = 200_000;
const AUTO_COMPACT_IDLE_MS = 60 * 60 * 1000;

/**
 * The kernel is the main entry point for the agentara application.
 * Lazy-creation singleton: the instance is created on first `getInstance()`.
 */
class Kernel {
  private _logger = createLogger("kernel");
  private _database!: DataConnection;
  private _sessionManager!: SessionManager;
  private _taskDispatcher!: TaskDispatcher;
  private _messageGateway!: MultiChannelMessageGateway;
  private _honoServer!: HonoServer;
  private _workspaceStore!: GroupWorkspaceStore;
  private _commandRegistry!: CommandRegistry;
  private _feishuChannels = new Map<string, FeishuMessageChannel>();
  private _setupFlow!: SetupFlow;
  private _switchFlow!: SwitchFlow;
  private _settingFlow!: SettingFlow;
  private _reposFlow!: ReposFlow;
  private _groupFlow!: GroupFlow;
  private _permissionFlow!: PermissionFlow;
  private _codexResumeRestarts = new Map<
    string,
    { sessionId: string; message: UserMessage }
  >();
  private _shuttingDown = false;

  constructor() {
    this._initDatabase();
    this._initSessionManager();
    this._initWorkspaceStore();
    this._initCommandRegistry();
    this._initTaskDispatcher();
    this._initMessageGateway();
    this._initSetupFlow();
    this._initSwitchFlow();
    this._initSettingFlow();
    this._initReposFlow();
    this._initGroupFlow();
    this._initPermissionFlow();
    this._initServer();
  }

  get database(): DataConnection {
    return this._database;
  }

  get sessionManager(): SessionManager {
    return this._sessionManager;
  }

  get taskDispatcher(): TaskDispatcher {
    return this._taskDispatcher;
  }

  get honoServer(): HonoServer {
    return this._honoServer;
  }

  get permissionFlow(): PermissionFlow {
    return this._permissionFlow;
  }

  private _initDatabase(): void {
    this._database = new DataConnection({
      ...taskingSchema,
      ...sessioningSchema,
      ...feishuMessagingSchema,
    });
  }

  private _initSessionManager(): void {
    this._sessionManager = new SessionManager(this._database.db);
  }

  private _initWorkspaceStore(): void {
    this._workspaceStore = new GroupWorkspaceStore(this._database.db);
    this._workspaceStore.ensureBaseDirs();
  }

  private _initCommandRegistry(): void {
    this._commandRegistry = new CommandRegistry();
  }

  private _initServer(): void {
    this._honoServer = new HonoServer();
  }

  private _initTaskDispatcher(): void {
    this._taskDispatcher = new TaskDispatcher({
      db: this._database.db,
    });
    this._taskDispatcher.route(
      "inbound_message",
      this._handleInboundMessageTask,
    );
    this._taskDispatcher.route("scheduled_task", this._handleScheduledTask);
  }

  private _initMessageGateway(): void {
    this._messageGateway = new MultiChannelMessageGateway(this._database.db);
    for (const channel of config.messaging.channels) {
      const splitCsv = (raw: string | undefined) =>
        (raw ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
      const allowedOpenIds = splitCsv(channel.params.allowed_user_ids);
      const allowedEmails = splitCsv(channel.params.allowed_user_emails);
      const requireMention =
        (channel.params.require_mention ?? "").toLowerCase() === "true";
      const feishuChannel = new FeishuMessageChannel(
        channel.id,
        {
          chatId: channel.params.chat_id!,
          appId: channel.params.app_id!,
          appSecret: channel.params.app_secret!,
          requireMention,
          allowedUserOpenIds:
            allowedOpenIds.length > 0 ? allowedOpenIds : undefined,
          allowedUserEmails:
            allowedEmails.length > 0 ? allowedEmails : undefined,
          // Uploads and quoted-resource downloads land inside the workspace
          // the chat is currently bound to, so each chat's artifacts stay
          // co-located with its session instead of piling up in a shared
          // `$AGENTARA_HOME/workspace/uploads` pool.
          resolveWorkspaceCwd: (chatId) =>
            this._workspaceStore.resolve(chatId).cwd,
          // Outbound relative paths (agent-generated file/image links) are
          // relative to the cwd the agent actually ran in. A single channel
          // serves many chats, so resolve from the owning session, not the
          // channel's configured chat.
          resolveSessionCwd: (sessionId) =>
            this._sessionManager.getSession(sessionId)?.cwd,
        },
        this._database.db,
      );
      this._feishuChannels.set(channel.id, feishuChannel);
      this._messageGateway.registerChannel(feishuChannel);
    }
    // `.on` discards the listener's returned promise, so any rejection that
    // escapes an async handler becomes an unhandled rejection (which crashes
    // the process). Guard the handler we drive the most — inbound messages.
    this._messageGateway.on("message:inbound", (message) => {
      void this._handleInboundMessage(message).catch((err) =>
        this._logger.error(
          { err },
          "unhandled error in inbound message handler",
        ),
      );
    });
    this._messageGateway.on("message:recalled", this._handleMessageRecall);
    this._messageGateway.on("card:action", this._handleCardAction);
  }

  private _initSetupFlow(): void {
    this._setupFlow = new SetupFlow({
      workspaceStore: this._workspaceStore,
      feishuChannels: this._feishuChannels,
    });
  }

  private _initSwitchFlow(): void {
    this._switchFlow = new SwitchFlow({
      workspaceStore: this._workspaceStore,
      feishuChannels: this._feishuChannels,
    });
  }

  private _initGroupFlow(): void {
    this._groupFlow = new GroupFlow({
      feishuChannels: this._feishuChannels,
      setupFlow: this._setupFlow,
      db: this._database.db,
    });
  }

  private _initSettingFlow(): void {
    this._settingFlow = new SettingFlow({
      workspaceStore: this._workspaceStore,
      feishuChannels: this._feishuChannels,
      db: this._database.db,
    });
  }

  private _initReposFlow(): void {
    this._reposFlow = new ReposFlow({
      feishuChannels: this._feishuChannels,
    });
  }

  private _initPermissionFlow(): void {
    this._permissionFlow = new PermissionFlow({
      feishuChannels: this._feishuChannels,
    });
  }

  /**
   * Start the kernel.
   */
  async start(): Promise<void> {
    await this._sessionManager.start();
    await this._taskDispatcher.start();
    await this._honoServer.start();
    this._publishPermissionEndpointEnv();
    await this._messageGateway.start();
    this._registerShutdownHandlers();
  }

  /**
   * Graceful shutdown: expire every outstanding interactive card (permission,
   * clarifying question, codex-resume) so a restart leaves no card that looks
   * live but can never resolve — the agent subprocesses awaiting them are
   * killed with this process. Runs while the Feishu channels are still
   * connected so the in-place card updates land. Idempotent.
   */
  async stop(reason?: string): Promise<void> {
    if (this._shuttingDown) return;
    this._shuttingDown = true;
    this._logger.info({ reason }, "kernel shutting down; expiring open cards");
    try {
      await this._permissionFlow.expireAllPending();
      await this._expireCodexResumeCards();
    } catch (err) {
      this._logger.error({ err }, "error while expiring cards on shutdown");
    }
  }

  /**
   * Wire SIGINT/SIGTERM to {@link Kernel.stop} so an operator restart or a
   * `bun --watch` reload expires open cards before the process exits.
   */
  private _registerShutdownHandlers(): void {
    const onSignal = (signal: NodeJS.Signals) => {
      void this.stop(signal).finally(() => process.exit(0));
    };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  }

  /** Expire any open codex-resume cards left in the in-memory registry. */
  private async _expireCodexResumeCards(): Promise<void> {
    const entries = [...this._codexResumeRestarts.entries()];
    this._codexResumeRestarts.clear();
    for (const [messageId, pending] of entries) {
      const channelId = pending.message.channel_id;
      const channel = channelId
        ? this._feishuChannels.get(channelId)
        : undefined;
      if (!channel) continue;
      try {
        await channel.updateRawCard(messageId, buildCodexResumeExpiredCard());
      } catch (err) {
        this._logger.warn(
          { err, message_id: messageId },
          "failed to expire codex resume card on shutdown",
        );
      }
    }
  }

  /**
   * Expose the internal approval endpoint + per-boot token via
   * `process.env` so runners in `src/community/*` can pick them up
   * without importing from `@/kernel` (which would reverse the
   * dependency direction). The MCP subprocess spawned by Claude
   * reads these at spawn time; the host only advertises them after
   * Hono has bound its port.
   */
  private _publishPermissionEndpointEnv(): void {
    const port = parseInt(Bun.env.AGENTARA_SERVICE_PORT ?? "1984", 10);
    // Force localhost — the endpoint is not internet-reachable even
    // if Hono binds to 0.0.0.0, because the bearer token rotates per
    // boot and isn't persisted.
    const url = `http://127.0.0.1:${port}/internal/permission/request`;
    process.env.AGENTARA_PERMISSION_URL = url;
    process.env.AGENTARA_PERMISSION_TOKEN = this._permissionFlow.apiToken;
  }

  private _handleInboundMessage = async (message: UserMessage) => {
    // Feishu substitutes @mentions as `@_user_N` placeholders. Two-tier
    // stripping:
    //   - Always drop LEADING placeholder runs so users can `@bot /foo` in
    //     any context (new session, inside a thread, etc.) and still hit
    //     gateway-level slash routing.
    //   - On the first message of a session, strip ALL placeholders — the
    //     whole line is the user summoning the bot; nothing else in it
    //     references a real collaborator.
    // Non-leading placeholders are preserved mid-session so real @-mentions
    // (e.g. `/allow @other_user`, or regular chatter) aren't mangled.
    const isSessionStart = !this._sessionManager.existsSession(
      message.session_id,
    );
    const rawText = extractTextContent(message);
    const trimmed = rawText.trim().replace(/^(?:@_user_\d+\s*)+/, "");
    const text = isSessionStart
      ? trimmed.replace(/@_user_\d+/g, "").trim()
      : trimmed.trim();

    // Handle /stop command (kernel-owned because it talks to TaskDispatcher)
    if (text === "/stop") {
      await this._handleStopCommand(message);
      return;
    }

    // Handle /setup command (kernel-owned — renders an interactive card and
    // awaits a card:action callback rather than returning a plain text reply).
    if (text === "/setup") {
      await this._setupFlow.start(message);
      return;
    }

    // Handle /switch command (kernel-owned — interactive card). Available in
    // both group chats and P2P since switching binding only touches metadata.
    if (text === "/switch") {
      await this._switchFlow.start(message);
      return;
    }

    // Handle /setting + /workspaces commands (kernel-owned — interactive
    // panel). Both open the same main card; the name duplication is just a
    // convenience shortcut for users who only want the workspace view.
    if (text === "/setting" || text === "/workspaces") {
      await this._settingFlow.start(message);
      return;
    }

    // Handle /repos command (kernel-owned — interactive card to manage
    // REPOS.md entries the same way /setting manages workspaces).
    if (text === "/repos") {
      await this._reposFlow.start(message);
      return;
    }

    // Handle /group command (kernel-owned — orchestrates create-chat +
    // transfer-owner + auto /setup). Takes args, so match the prefix rather
    // than equality.
    if (text === "/group" || text.startsWith("/group ")) {
      await this._groupFlow.start(message);
      return;
    }

    // Handle /new command (kernel-owned — forks a fresh session + fresh
    // Feishu thread, optionally carrying the post-slash text as the first
    // agent prompt). Equivalent to @-mentioning the bot in the main chat.
    if (isNewCommand(text)) {
      await this._handleNewCommand(message, text);
      return;
    }

    // Gateway-level slash commands: any `/`-prefixed message is resolved
    // here first.
    //   1. Registered command → run it and stop.
    //   2. Passthrough-whitelisted (e.g. `/compact`) → fall through to the
    //      normal agent dispatch so the underlying CLI (Claude Code) handles
    //      its own slash command.
    //   3. Anything else → reply "unknown command" rather than wasting an
    //      agent turn on a likely typo.
    if (text.startsWith("/")) {
      const handled = await this._tryHandleCommand(message, text);
      if (handled) return;
      const parsed = parseCommand(text);
      if (!parsed || !isPassthroughCommand(parsed.name)) {
        await this._replyUnknownCommand(message, text);
        return;
      }
      // Whitelisted passthrough — fall through to the agent dispatch below.
    }

    // On the first message of a new session, kick off a best-effort
    // fetch + ff-pull across the workspace so the agent sees latest remote
    // state. Fire-and-forget: the pull is atomic at the git level, the
    // agent dispatch queue gives it a head start, and we don't want a
    // flaky network to block the user's first turn.
    if (isSessionStart && message.chat_id) {
      this._autoSyncOnSessionStart(message.chat_id);
    }

    const task: InboundMessageTaskPayload = {
      type: "inbound_message",
      message,
    };
    await this._taskDispatcher.dispatch(message.session_id, task);
  };

  private _autoSyncOnSessionStart(chatId: string): void {
    const resolution = this._workspaceStore.resolve(chatId);
    if (!resolution.binding) return;
    const workspacePath = resolution.binding.workspace_path;
    syncWorkspace(workspacePath, { pull: true, timeout_ms: 15_000 })
      .then((results) => {
        const ff = results.filter((r) => r.status === "fast_forwarded");
        if (ff.length > 0) {
          this._logger.info(
            {
              chat_id: chatId,
              workspace: workspacePath,
              fast_forwarded: ff.map((r) => ({
                repo: r.name,
                branch: r.branch,
                before: r.before_sha,
                after: r.after_sha,
              })),
            },
            "session-start auto-sync fast-forwarded",
          );
        }
      })
      .catch((err) => {
        this._logger.warn(
          { err, chat_id: chatId, workspace: workspacePath },
          "session-start auto-sync failed",
        );
      });
  }

  private _handleNewCommand = async (message: UserMessage, text: string) => {
    // Feishu threads don't nest: replying to an already-threaded message
    // with reply_in_thread:true stays in the same thread. Running /new
    // inside a thread would silently fold the "new" session into the
    // existing one and overwrite its thread→session mapping. Reject.
    if (message.thread_id) {
      const reply = buildNewCommandRejectionReply();
      await this._replyTextOrCard(message, reply.text, reply.card, "new");
      return;
    }

    const prompt = extractNewPrompt(text);
    if (!prompt) {
      const reply = buildNewCommandUsageReply();
      await this._replyTextOrCard(message, reply.text, reply.card, "new");
      return;
    }

    // Fork: fresh session_id so isSessionStart flips true, and
    // thread_id=undefined so replyMessage(replyInThread:true) creates a
    // brand-new Feishu thread rooted at this user message.
    const newMessage = createFreshUserMessage(message, prompt, uuid());
    this._logger.info(
      {
        old_session_id: message.session_id,
        new_session_id: newMessage.session_id,
        chat_id: message.chat_id,
        message_id: message.id,
      },
      "/new starting fresh session + thread",
    );
    if (newMessage.chat_id) {
      this._autoSyncOnSessionStart(newMessage.chat_id);
    }
    await this._taskDispatcher.dispatch(newMessage.session_id, {
      type: "inbound_message",
      message: newMessage,
    });
  };

  private _replyUnknownCommand = async (
    message: UserMessage,
    text: string,
  ): Promise<void> => {
    const reply = buildUnknownCommandReply(text);
    await this._replyTextOrCard(message, reply.text, reply.card, "unknown");
  };

  private _tryHandleCommand = async (
    message: UserMessage,
    text: string,
  ): Promise<boolean> => {
    const parsed = parseCommand(text);
    if (!parsed) return false;
    const handler = this._commandRegistry.get(parsed.name);
    if (!handler) return false;
    let replyText: string;
    let replyCard: CardCommandResult | null = null;
    try {
      const result = await handler.execute({
        message,
        args: parsed.args,
        raw: parsed.raw,
        workspaceStore: this._workspaceStore,
        feishuChannels: this._feishuChannels,
        sessionManager: this._sessionManager,
        taskDispatcher: this._taskDispatcher,
        readSessionUsageSnapshot: readLatestSessionUsageSnapshot,
        logger: this._logger,
      });
      if (typeof result === "string") {
        replyText = result;
      } else if (result.kind === "deferred_card") {
        await this._handleDeferredCard(message, result, parsed.name);
        return true;
      } else {
        replyText = result.fallback_text;
        replyCard = result;
      }
    } catch (err) {
      this._logger.error(
        { err, command: parsed.name, chat_id: message.chat_id },
        "command handler failed",
      );
      replyText = `❌ 命令 \`/${parsed.name}\` 执行失败：${(err as Error).message}`;
    }
    await this._replyTextOrCard(
      message,
      replyText,
      replyCard?.card,
      parsed.name,
    );
    return true;
  };

  /**
   * Drive a {@link DeferredCardCommandResult}: post the pending card, run the
   * slow work in the background, then patch the same message with the final
   * card. Every step is guarded — a failure to render, run, or patch is
   * logged but never allowed to escape (which would crash the process via an
   * unhandled rejection on the fire-and-forget inbound handler).
   */
  private async _handleDeferredCard(
    message: UserMessage,
    result: DeferredCardCommandResult,
    commandName: string,
  ): Promise<void> {
    const channel = message.channel_id
      ? this._feishuChannels.get(message.channel_id)
      : undefined;

    // No card-capable channel: just run and reply with the final card/text.
    if (!channel || !message.chat_id) {
      try {
        const finalCard = await result.run();
        await this._replyTextOrCard(
          message,
          result.fallback_text,
          finalCard,
          commandName,
        );
      } catch (err) {
        this._logger.error(
          { err, command: commandName },
          "deferred command failed",
        );
        await this._replyTextOrCard(
          message,
          `❌ 命令 \`/${commandName}\` 执行失败：${(err as Error).message}`,
          undefined,
          commandName,
        );
      }
      return;
    }

    let cardMessageId: string;
    try {
      cardMessageId = await channel.sendRawCard(message.chat_id, result.initial, {
        replyTo: message.id,
        replyInThread: false,
      });
    } catch (err) {
      // Couldn't show the pending card; still run the work and reply with the
      // final result through the text-safe path so the user isn't left hanging.
      this._logger.error(
        { err, command: commandName, message_id: message.id },
        "deferred initial card failed; falling back to text",
      );
      void result
        .run()
        .then((finalCard) =>
          this._replyTextOrCard(
            message,
            result.fallback_text,
            finalCard,
            commandName,
          ),
        )
        .catch((runErr) =>
          this._logger.error(
            { err: runErr, command: commandName },
            "deferred run failed after initial card error",
          ),
        );
      return;
    }

    // Fire-and-forget the slow work; fully guarded so it can never crash.
    void (async () => {
      try {
        const finalCard = await result.run();
        await channel.updateRawCard(cardMessageId, finalCard);
      } catch (err) {
        this._logger.error(
          { err, command: commandName, card_message_id: cardMessageId },
          "deferred command run failed",
        );
        try {
          await channel.updateRawCard(
            cardMessageId,
            buildCommandCard({
              title: "执行失败",
              lines: [`❌ ${(err as Error).message}`],
            }),
          );
        } catch (patchErr) {
          this._logger.error(
            { err: patchErr, card_message_id: cardMessageId },
            "deferred failure card update failed",
          );
        }
      }
    })();
  }

  private _handleStopCommand = async (message: UserMessage) => {
    const sessionId = message.session_id;
    const runningTaskId =
      this._taskDispatcher.getRunningTaskForSession(sessionId);

    if (runningTaskId) {
      await this._taskDispatcher.deleteTask(runningTaskId);
      await this._replyTextOrCard(
        message,
        "✅ 任务已取消。",
        buildCommandCard({
          title: "停止任务",
          lines: ["✅ 任务已取消。"],
        }),
        "stop",
      );
    } else {
      await this._replyTextOrCard(
        message,
        "ℹ️  当前 session 没有正在执行的任务。",
        buildCommandCard({
          title: "停止任务",
          lines: ["ℹ️  当前 session 没有正在执行的任务。"],
        }),
        "stop",
      );
    }
  };

  private async _replyTextOrCard(
    message: UserMessage,
    text: string,
    card?: Card,
    commandName?: string,
  ): Promise<void> {
    const channel = message.channel_id
      ? this._feishuChannels.get(message.channel_id)
      : undefined;

    if (card && message.chat_id && channel) {
      try {
        await channel.sendRawCard(message.chat_id, card, {
          replyTo: message.id,
          replyInThread: false,
        });
        return;
      } catch (err) {
        this._logger.error(
          {
            err,
            command: commandName,
            message_id: message.id,
            chat_id: message.chat_id,
          },
          "command card reply failed; falling back to text",
        );
      }
    }

    // Text fallback. This must never throw out of here: an unhandled
    // rejection on the fire-and-forget inbound handler crashes the process.
    try {
      await this._messageGateway.replyMessage(
        message.id,
        {
          role: "assistant",
          session_id: message.session_id,
          content: [{ type: "text", text }],
        },
        {
          channelId: message.channel_id,
          streaming: false,
          replyInThread: false,
        },
      );
    } catch (err) {
      this._logger.error(
        { err, command: commandName, message_id: message.id },
        "text fallback reply failed; trying plain text",
      );
      // Last resort: a real plain-text message (not a card reply, which is
      // what just failed) posted straight to the chat.
      if (channel && message.chat_id) {
        try {
          await channel.sendPlainText(message.chat_id, text);
        } catch (plainErr) {
          this._logger.error(
            { err: plainErr, message_id: message.id },
            "plain-text fallback also failed; giving up",
          );
        }
      }
    }
  }

  private _handleMessageRecall = async (
    messageId: string,
    channelId: string,
  ) => {
    const taskId = this._taskDispatcher.getTaskByMessageId(messageId);
    if (taskId) {
      await this._taskDispatcher.deleteTask(taskId);
      this._logger.info(
        { message_id: messageId, task_id: taskId, channel_id: channelId },
        "task stopped due to message recall",
      );
    }
  };

  /**
   * Route card-action callbacks by the `action_name` discriminator. Each
   * interactive flow owns its own `action_name`; unknown actions are logged
   * and dropped.
   */
  private _handleCardAction = async (payload: CardActionPayload) => {
    if (payload.action_name === "setup_submit") {
      await this._setupFlow.handleSubmit(payload);
      return;
    }
    if (payload.action_name === SETUP_DISMISS_ACTION) {
      await this._setupFlow.handleDismiss(payload);
      return;
    }
    if (payload.action_name === "switch_submit") {
      await this._switchFlow.handleSubmit(payload);
      return;
    }
    if (payload.action_name === PERMISSION_ACTION) {
      await this._permissionFlow.handleDecide(payload);
      return;
    }
    if (payload.action_name === QUESTION_ACTION) {
      await this._permissionFlow.handleQuestionSubmit(payload);
      return;
    }
    if (payload.action_name === CODEX_RESUME_RESTART_ACTION) {
      await this._handleCodexResumeRestart(payload);
      return;
    }
    if (payload.action_name.startsWith("setting_")) {
      await this._settingFlow.handleAction(payload);
      return;
    }
    if (payload.action_name.startsWith("repos_")) {
      await this._reposFlow.handleAction(payload);
      return;
    }
    this._logger.warn(
      { action_name: payload.action_name, message_id: payload.message_id },
      "unhandled card action",
    );
  };

  private _handleInboundMessageTask = async (
    taskId: string,
    sessionId: string,
    payload: InboundMessageTaskPayload,
    signal?: AbortSignal,
  ) => {
    const inboundMessage = payload.message;
    const resolution = this._workspaceStore.resolve(inboundMessage.chat_id);
    const existingSession = this._sessionManager.getSession(sessionId);
    const session = await this._sessionManager.resolveSession(sessionId, {
      channelId: inboundMessage.channel_id,
      chatId: inboundMessage.chat_id,
      threadId: inboundMessage.thread_id,
      cwd: resolution.cwd,
      envExtras: resolution.envExtras,
      forceNewRunnerSession: payload.forceNewRunnerSession,
      firstMessage: inboundMessage,
    });
    await this._maybeAutoCompactIdleHighContextSession(
      session,
      inboundMessage,
      existingSession,
      signal,
    );

    let contents: AssistantMessage["content"] = [
      {
        type: "thinking",
        thinking: "Thinking...",
      },
    ];
    const outboundMessage = await this._messageGateway.replyMessage(
      inboundMessage.id,
      {
        role: "assistant",
        session_id: session.id,
        content: contents,
      },
      {
        streaming: true,
      },
    );
    contents = [];
    let lastMessage: AssistantMessage | undefined;
    // Footer stats come from the most recent turn that actually reported
    // usage — trailing synthetic messages (compaction notices) carry no
    // usage/model and would otherwise blank out the footer.
    let lastUsageMessage: AssistantMessage | undefined;
    try {
      const stream = await session.stream(inboundMessage, { signal });
      for await (const message of stream) {
        if (message.role === "assistant") {
          contents.push(...message.content);
          await this._messageGateway.updateMessageContent(
            { ...outboundMessage, content: contents },
            {
              streaming: true,
            },
          );
          lastMessage = message;
          if (message.usage) lastUsageMessage = message;
        }
      }
      if (!lastMessage) {
        throw new Error("No assistant message received from the agent.");
      }
      this._sessionManager.markSuccessfulInteraction(session.id);
    } catch (err) {
      if (err instanceof CodexMissingResumeError) {
        await this._handleCodexMissingResume(
          err,
          inboundMessage,
          session.id,
          outboundMessage,
        );
        throw err;
      }
      const failureContent = signal?.aborted
        ? buildAgentCancelledContent()
        : buildAgentFailureContent(err, { sessionId: session.id });
      try {
        await this._messageGateway.updateMessageContent(
          { ...outboundMessage, content: failureContent },
          {
            streaming: false,
          },
        );
      } catch (updateErr) {
        this._logger.error(
          {
            err: updateErr,
            session_id: session.id,
            outbound_message_id: outboundMessage.id,
          },
          "failed to update assistant message after agent failure",
        );
      }
      throw err;
    }
    await this._messageGateway.updateMessageContent(
      { ...outboundMessage, content: contents },
      {
        streaming: false,
        footer: await this._buildCardFooter(lastUsageMessage),
      },
    );
  };

  private async _maybeAutoCompactIdleHighContextSession(
    session: Awaited<ReturnType<SessionManager["resolveSession"]>>,
    inboundMessage: UserMessage,
    existingSession: SessionEntity | undefined,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!existingSession) return;
    if (session.options.isNewSession) return;
    if (!this._supportsAutoCompact(session.agentType)) return;
    const inboundText = extractTextContent(inboundMessage)
      .trim()
      .replace(/^(?:@_user_\d+\s*)+/, "");
    if (inboundText === "/compact") return;

    const lastInteractionAt = existingSession.last_message_created_at;
    if (!lastInteractionAt) return;
    const idleMs = Date.now() - lastInteractionAt;
    if (idleMs <= AUTO_COMPACT_IDLE_MS) return;

    const usage = readLatestSessionUsageSnapshot(session.id);
    if (!usage || usage.used_tokens <= AUTO_COMPACT_TOKEN_THRESHOLD) return;

    this._logger.info(
      {
        session_id: session.id,
        agent_type: session.agentType,
        used_tokens: usage.used_tokens,
        idle_ms: idleMs,
      },
      "auto-compacting idle high-context session before user turn",
    );

    const statusCard = await this._tryCreateAutoCompactStatusCard(
      inboundMessage,
      session.id,
      [
        {
          type: "text",
          text: "检测到当前会话上下文已超过 200k tokens，且超过 1 小时没有交互，正在先自动执行 /compact 压缩上下文…",
        },
      ],
    );

    try {
      await session.run(
        {
          ...inboundMessage,
          id: `${inboundMessage.id}:auto-compact`,
          content: [{ type: "text", text: "/compact" }],
        },
        { signal },
      );
      await this._tryUpdateAutoCompactStatus(statusCard, [
        {
          type: "text",
          text: "自动压缩已完成，继续处理你的消息…",
        },
      ]);
    } catch (err) {
      this._logger.warn(
        {
          err,
          session_id: session.id,
          used_tokens: usage.used_tokens,
          idle_ms: idleMs,
        },
        "auto-compact before user turn failed; continuing with original message",
      );
      await this._tryUpdateAutoCompactStatus(statusCard, [
        {
          type: "text",
          text: "自动压缩未完成，已继续处理你的消息…",
        },
      ]);
    }
  }

  private async _tryCreateAutoCompactStatusCard(
    inboundMessage: UserMessage,
    sessionId: string,
    content: AssistantMessage["content"],
  ): Promise<AssistantMessage | undefined> {
    try {
      return await this._messageGateway.replyMessage(
        inboundMessage.id,
        {
          role: "assistant",
          session_id: sessionId,
          content,
        },
        { streaming: true },
      );
    } catch (err) {
      this._logger.warn(
        {
          err,
          inbound_message_id: inboundMessage.id,
          session_id: sessionId,
        },
        "failed to create auto-compact status card",
      );
      return undefined;
    }
  }

  private async _tryUpdateAutoCompactStatus(
    outboundMessage: AssistantMessage | undefined,
    content: AssistantMessage["content"],
  ): Promise<void> {
    if (!outboundMessage) return;
    try {
      await this._messageGateway.updateMessageContent(
        { ...outboundMessage, content },
        { streaming: false },
      );
    } catch (err) {
      this._logger.warn(
        {
          err,
          outbound_message_id: outboundMessage.id,
          session_id: outboundMessage.session_id,
        },
        "failed to update auto-compact status card",
      );
    }
  }

  private _supportsAutoCompact(agentType: string): boolean {
    return agentType.toLowerCase().includes("claude");
  }

  /**
   * Assemble the finalized card's footer stats: context-window occupancy
   * for the latest turn (from the agent's reported token usage) plus the
   * account's rolling 5-hour / 7-day quota. Scoped to runs that surface
   * token usage (Claude) — other runners get no footer. Best-effort: a
   * failed quota lookup still returns the context bar, and any error
   * yields `undefined` so a footer never breaks a reply.
   */
  private async _buildCardFooter(
    lastMessage?: AssistantMessage,
  ): Promise<CardFooterStats | undefined> {
    const usage = lastMessage?.usage;
    if (!usage) return undefined;
    try {
      const stats: CardFooterStats = {};
      // Prefer the model the runner actually resolved; fall back to the
      // configured one (often unset). Used for both display and the
      // context-window limit.
      const model = lastMessage?.model ?? config.agents.default.model;
      if (model) stats.model = model;
      const usedTokens =
        (usage.input_tokens ?? 0) +
        (usage.cache_read_input_tokens ?? 0) +
        (usage.cache_creation_input_tokens ?? 0) +
        (usage.output_tokens ?? 0);
      if (usedTokens > 0) {
        stats.context = {
          used_tokens: usedTokens,
          limit_tokens: contextLimitForModel(model),
        };
      }
      const quota = await getClaudeUsageCached();
      if (quota) {
        stats.five_hour = {
          utilization: quota.five_hour.utilization,
          resets_at: quota.five_hour.resets_at,
        };
        stats.seven_day = {
          utilization: quota.seven_day.utilization,
          resets_at: quota.seven_day.resets_at,
        };
      }
      return Object.keys(stats).length > 0 ? stats : undefined;
    } catch (err) {
      this._logger.warn({ err }, "failed to build card footer stats");
      return undefined;
    }
  }

  private async _handleCodexMissingResume(
    err: CodexMissingResumeError,
    inboundMessage: UserMessage,
    sessionId: string,
    outboundMessage: AssistantMessage,
  ): Promise<void> {
    const card = buildCodexResumeMissingCard({ resumeId: err.resumeId });
    const channel =
      inboundMessage.channel_id && inboundMessage.chat_id
        ? this._feishuChannels.get(inboundMessage.channel_id)
        : undefined;
    if (channel) {
      try {
        await channel.updateRawCard(outboundMessage.id, card);
        this._codexResumeRestarts.set(outboundMessage.id, {
          sessionId,
          message: inboundMessage,
        });
        return;
      } catch (updateErr) {
        this._logger.error(
          {
            err: updateErr,
            session_id: sessionId,
            outbound_message_id: outboundMessage.id,
          },
          "failed to update Codex resume recovery card",
        );
      }
    }

    await this._messageGateway.updateMessageContent(
      {
        ...outboundMessage,
        content: [
          {
            type: "text",
            text: formatCodexResumeMissingText(err.resumeId),
          },
        ],
      },
      { streaming: false },
    );
  }

  private async _handleCodexResumeRestart(
    payload: CardActionPayload,
  ): Promise<void> {
    const pending = this._codexResumeRestarts.get(payload.message_id);
    const channel = this._feishuChannels.get(payload.channel_id);
    if (!pending) {
      if (channel) {
        await channel.updateRawCard(
          payload.message_id,
          buildCodexResumeExpiredCard(),
        );
      }
      return;
    }
    this._codexResumeRestarts.delete(payload.message_id);
    if (channel) {
      await channel.updateRawCard(
        payload.message_id,
        buildCodexResumeRestartingCard(),
      );
    }
    this._sessionManager.resetRunnerSessionId(pending.sessionId);
    await this._taskDispatcher.dispatch(pending.sessionId, {
      type: "inbound_message",
      message: pending.message,
      forceNewRunnerSession: true,
    });
    if (channel) {
      await channel.updateRawCard(
        payload.message_id,
        buildCodexResumeRestartedCard(),
      );
    }
  }

  private _handleScheduledTask = async (
    _taskId: string,
    sessionId: string,
    payload: ScheduledTaskPayload,
    signal?: AbortSignal,
  ) => {
    const payload_without_instruction: { instruction?: string } = {
      ...payload,
    };
    const defaultChannelId = config.messaging.default_channel_id;
    const userMessage: UserMessage = {
      id: uuid(),
      role: "user",
      session_id: sessionId,
      channel_id: defaultChannelId,
      content: [
        {
          type: "text",
          text: `> This message is automatically triggered by a scheduled task.
> The time is now ${new Date().toString()}.
> Cron expression: \`${JSON.stringify(payload_without_instruction)}\`

${payload.instruction}`,
        },
      ],
    };
    const session = await this._sessionManager.resolveSession(sessionId, {
      channelId: userMessage.channel_id,
      firstMessage: userMessage,
    });
    delete payload_without_instruction.instruction;
    const assistantMessage = await session.run(userMessage, { signal });
    if (extractTextContent(assistantMessage).includes("[SKIPPED]")) {
      return;
    }
    this._sessionManager.markSuccessfulInteraction(session.id);
    await this._messageGateway.postMessage(assistantMessage);
  };
}

export const kernel = new Kernel();
