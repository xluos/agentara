import { FeishuMessageChannel } from "@/community/feishu";
import * as feishuMessagingSchema from "@/community/feishu/messaging/data";
import type { Card } from "@/community/feishu/messaging/types";
import { DataConnection } from "@/data";
import type { AssistantMessage, CardActionPayload, UserMessage } from "@/shared";
import {
  config,
  createLogger,
  extractTextContent,
  uuid,
  type InboundMessageTaskPayload,
  type ScheduledTaskPayload,
} from "@/shared";

import { HonoServer } from "../server";

import { CommandRegistry, parseCommand, type CardCommandResult } from "./commands";
import { buildCommandCard } from "./commands/cards";
import { GroupFlow } from "./group/group-flow";
import { MultiChannelMessageGateway } from "./messaging";
import { SessionManager } from "./sessioning";
import * as sessioningSchema from "./sessioning/data";
import { SetupFlow } from "./setup/setup-flow";
import { SwitchFlow } from "./setup/switch-flow";
import { TaskDispatcher } from "./tasking";
import * as taskingSchema from "./tasking/data";
import { GroupWorkspaceStore, syncWorkspace } from "./workspaces";

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
  private _groupFlow!: GroupFlow;

  constructor() {
    this._initDatabase();
    this._initSessionManager();
    this._initWorkspaceStore();
    this._initCommandRegistry();
    this._initTaskDispatcher();
    this._initMessageGateway();
    this._initSetupFlow();
    this._initSwitchFlow();
    this._initGroupFlow();
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
        },
        this._database.db,
      );
      this._feishuChannels.set(channel.id, feishuChannel);
      this._messageGateway.registerChannel(feishuChannel);
    }
    this._messageGateway.on("message:inbound", this._handleInboundMessage);
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

  /**
   * Start the kernel.
   */
  async start(): Promise<void> {
    await this._sessionManager.start();
    await this._taskDispatcher.start();
    await this._honoServer.start();
    await this._messageGateway.start();
  }

  private _handleInboundMessage = async (message: UserMessage) => {
    // Feishu substitutes @mentions as `@_user_N` placeholders. Strip them
    // ONLY on the first message of a session (the user @-summoning the bot
    // to start a thread) so that `@bot /bind foo` routes through the slash
    // command path. Subsequent messages inside the same thread keep their
    // placeholders intact so real @-mentions of other users aren't mangled.
    const isSessionStart = !this._sessionManager.existsSession(
      message.session_id,
    );
    const rawText = extractTextContent(message);
    const text = isSessionStart
      ? rawText.replace(/@_user_\d+/g, "").trim()
      : rawText.trim();

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

    // Handle /group command (kernel-owned — orchestrates create-chat +
    // transfer-owner + auto /setup). Takes args, so match the prefix rather
    // than equality.
    if (text === "/group" || text.startsWith("/group ")) {
      await this._groupFlow.start(message);
      return;
    }

    // Try gateway-level slash commands before dispatching to the LLM.
    if (text.startsWith("/")) {
      const handled = await this._tryHandleCommand(message, text);
      if (handled) return;
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
        logger: this._logger,
      });
      if (typeof result === "string") {
        replyText = result;
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
    if (
      card &&
      message.channel_id &&
      message.chat_id &&
      this._feishuChannels.get(message.channel_id)
    ) {
      try {
        await this._feishuChannels.get(message.channel_id)!.sendRawCard(
          message.chat_id,
          card,
          {
            replyTo: message.id,
            replyInThread: false,
          },
        );
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
    if (payload.action_name === "switch_submit") {
      await this._switchFlow.handleSubmit(payload);
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
    const session = await this._sessionManager.resolveSession(sessionId, {
      channelId: inboundMessage.channel_id,
      chatId: inboundMessage.chat_id,
      threadId: inboundMessage.thread_id,
      cwd: resolution.cwd,
      envExtras: resolution.envExtras,
      firstMessage: inboundMessage,
    });
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
    const stream = await session.stream(inboundMessage, { signal });
    let lastMessage: AssistantMessage | undefined;
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
      }
    }
    if (!lastMessage) {
      throw new Error("No assistant message received from the agent.");
    }
    await this._messageGateway.updateMessageContent(
      { ...outboundMessage, content: contents },
      {
        streaming: false,
      },
    );
  };

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
    await this._messageGateway.postMessage(assistantMessage);
  };
}

export const kernel = new Kernel();
