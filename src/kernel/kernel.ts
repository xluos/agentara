import { FeishuMessageChannel } from "@/community/feishu";
import * as feishuMessagingSchema from "@/community/feishu/messaging/data";
import { DataConnection } from "@/data";
import type { AssistantMessage, UserMessage } from "@/shared";
import {
  config,
  createLogger,
  extractTextContent,
  uuid,
  type InboundMessageTaskPayload,
  type ScheduledTaskPayload,
} from "@/shared";

import { HonoServer } from "../server";

import { CommandRegistry, parseCommand } from "./commands";
import { MultiChannelMessageGateway } from "./messaging";
import { SessionManager } from "./sessioning";
import * as sessioningSchema from "./sessioning/data";
import { TaskDispatcher } from "./tasking";
import * as taskingSchema from "./tasking/data";
import { GroupWorkspaceStore } from "./workspaces";

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

  constructor() {
    this._initDatabase();
    this._initSessionManager();
    this._initWorkspaceStore();
    this._initCommandRegistry();
    this._initTaskDispatcher();
    this._initMessageGateway();
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
      this._messageGateway.registerChannel(
        new FeishuMessageChannel(
          channel.id,
          {
            chatId: channel.params.chat_id!,
            appId: channel.params.app_id!,
            appSecret: channel.params.app_secret!,
          },
          this._database.db,
        ),
      );
    }
    this._messageGateway.on("message:inbound", this._handleInboundMessage);
    this._messageGateway.on("message:recalled", this._handleMessageRecall);
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
    const text = extractTextContent(message).trim();

    // Handle /stop command (kernel-owned because it talks to TaskDispatcher)
    if (text === "/stop") {
      await this._handleStopCommand(message);
      return;
    }

    // Try gateway-level slash commands before dispatching to the LLM.
    if (text.startsWith("/")) {
      const handled = await this._tryHandleCommand(message, text);
      if (handled) return;
    }

    const task: InboundMessageTaskPayload = {
      type: "inbound_message",
      message,
    };
    await this._taskDispatcher.dispatch(message.session_id, task);
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
    try {
      replyText = await handler.execute({
        message,
        args: parsed.args,
        raw: parsed.raw,
        workspaceStore: this._workspaceStore,
        logger: this._logger,
      });
    } catch (err) {
      this._logger.error(
        { err, command: parsed.name, chat_id: message.chat_id },
        "command handler failed",
      );
      replyText = `❌ Command \`/${parsed.name}\` failed: ${(err as Error).message}`;
    }
    await this._messageGateway.replyMessage(message.id, {
      role: "assistant",
      session_id: message.session_id,
      content: [{ type: "text", text: replyText }],
    });
    return true;
  };

  private _handleStopCommand = async (message: UserMessage) => {
    const sessionId = message.session_id;
    const runningTaskId =
      this._taskDispatcher.getRunningTaskForSession(sessionId);

    if (runningTaskId) {
      await this._taskDispatcher.deleteTask(runningTaskId);
      await this._messageGateway.replyMessage(message.id, {
        role: "assistant",
        session_id: sessionId,
        content: [{ type: "text", text: "Task stopped." }],
      });
    } else {
      await this._messageGateway.replyMessage(message.id, {
        role: "assistant",
        session_id: sessionId,
        content: [{ type: "text", text: "No running task found." }],
      });
    }
  };

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

  private _handleInboundMessageTask = async (
    taskId: string,
    sessionId: string,
    payload: InboundMessageTaskPayload,
    signal?: AbortSignal,
  ) => {
    const inboundMessage = payload.message;
    const resolution = this._workspaceStore.resolve(inboundMessage.chat_id);
    if (resolution.binding?.active_repo && resolution.binding.active_branch) {
      // Idempotent pre-checkout so the active repo is on the bound branch
      // before the runner spawns. Runs synchronously with the dispatch — if
      // it fails, we still proceed (binding may need user repair).
      try {
        const repoPath = `${resolution.binding.workspace_path}/${resolution.binding.active_repo}`;
        const proc = Bun.spawn(
          ["git", "-C", repoPath, "checkout", resolution.binding.active_branch],
          { stdout: "pipe", stderr: "pipe" },
        );
        await proc.exited;
      } catch (err) {
        this._logger.warn(
          { err, chat_id: inboundMessage.chat_id, binding: resolution.binding },
          "pre-dispatch git checkout failed; continuing",
        );
      }
    }
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
