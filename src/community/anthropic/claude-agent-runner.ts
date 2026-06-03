import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  config,
  createLogger,
  extractTextContent,
  inlineMentions,
  type MessageContent,
  type ToolMessage,
  type AgentRunner,
  type AgentRunOptions,
  type AssistantMessage,
  type SystemMessage,
  type UserMessage,
} from "@/shared";

const logger = createLogger("claude-agent-runner");

/**
 * Error thrown when the agent runner is aborted.
 */
export class AgentAbortError extends Error {
  constructor(message = "Agent execution was aborted") {
    super(message);
    this.name = "AgentAbortError";
  }
}

/**
 * The agent runner for Claude Code CLI.
 */
export class ClaudeAgentRunner implements AgentRunner {
  readonly type = "claude";

  async *stream(
    message: UserMessage,
    options: AgentRunOptions,
  ): AsyncIterableIterator<SystemMessage | AssistantMessage | ToolMessage> {
    const sessionId = message.session_id;
    const isNew = options?.isNewSession ?? false;
    const signal = options?.signal;
    const textContentOfUserMessage = JSON.stringify(
      inlineMentions(extractTextContent(message), message.mentions),
    );

    const configuredModel = config.agents.default.model;
    const args = [
      "claude",
      ...(!isNew ? ["--resume", sessionId] : ["--session-id", sessionId]),
      // Only pin the model when config names one; otherwise Claude CLI
      // picks its own default (user omitted `model` in config.yaml).
      ...(configuredModel ? ["--model", configuredModel] : []),
      ...(options.dangerouslySkipPermissions
        ? ["--dangerously-skip-permissions"]
        : []),
      ...["--output-format", "stream-json"],
    ];

    // Wire up the interactive permission MCP bridge when the inbound
    // message carries a known Feishu user (chat_id + channel_id +
    // sender_open_id) and the kernel has published its internal
    // approval endpoint into the env. Otherwise fall back to Claude's
    // default behavior (non-interactive, auto-deny for unapproved
    // tools) so scheduled-task and non-Feishu paths aren't broken.
    const permissionBridge = _buildPermissionBridge(message, options);
    if (permissionBridge) {
      args.push(
        "--mcp-config",
        permissionBridge.mcpConfigPath,
        "--permission-prompt-tool",
        "mcp__agentara__approve_tool_use",
      );
    }

    args.push("--print", "--verbose", textContentOfUserMessage);
    const proc = Bun.spawn(args, {
      cwd: options.cwd,
      env: {
        ...Bun.env,
        ...config.agents.env,
        ...(options.envExtras ?? {}),
        ANTHROPIC_API_KEY: "",
      },
      stderr: "pipe",
    });

    // Handle abort signal
    let aborted = false;
    const abortHandler = () => {
      aborted = true;
      logger.info({ session_id: sessionId }, "killing Claude Code process");
      proc.kill();
    };
    if (signal) {
      if (signal.aborted) {
        proc.kill();
        throw new AgentAbortError();
      }
      signal.addEventListener("abort", abortHandler, { once: true });
    }

    const decoder = new TextDecoder();
    const stderrChunks: Uint8Array[] = [];
    const stderrPipe = proc.stderr.pipeTo(
      new WritableStream({
        write(chunk) {
          stderrChunks.push(chunk);
        },
      }),
    );
    let buffer = "";
    let stdoutRaw = "";
    try {
      for await (const chunk of proc.stdout) {
        if (aborted) {
          break;
        }
        const decoded = decoder.decode(chunk, { stream: true });
        buffer += decoded;
        stdoutRaw += decoded;
        const lines = buffer.split("\n");
        buffer = lines.pop()!;
        for (const line of lines) {
          if (line.trim()) {
            const parsed = this._parseStreamLine(line.trim(), sessionId);
            if (parsed) {
              yield parsed;
            }
          }
        }
      }
      if (!aborted && buffer.trim()) {
        const parsed = this._parseStreamLine(buffer.trim(), sessionId);
        if (parsed) {
          yield parsed;
        }
      }
    } finally {
      if (signal) {
        signal.removeEventListener("abort", abortHandler);
      }
      permissionBridge?.cleanup();
    }

    if (aborted) {
      throw new AgentAbortError();
    }

    const exitCode = await proc.exited;
    await stderrPipe;
    if (exitCode !== 0) {
      const stderrText =
        stderrChunks.length > 0
          ? decoder.decode(Bun.concatArrayBuffers(stderrChunks))
          : "";
      const parts: string[] = [];
      // stdout is the (already-parsed) stream-json — can be megabytes, so
      // keep only a short tail where a trailing error result would land.
      // stderr carries the actual failure reason, so allow it more room.
      if (stdoutRaw.trim()) {
        parts.push(`Stdout:\n${_clipTail(stdoutRaw.trim(), 800)}`);
      }
      if (stderrText.trim()) {
        parts.push(`Stderr:\n${_clipTail(stderrText.trim(), 3000)}`);
      }
      const detail = parts.length > 0 ? `\n\n${parts.join("\n\n")}` : "";
      throw new Error(`Claude Code exited with code ${exitCode}${detail}`);
    }
  }

  private _parseStreamLine(
    line: string,
    sessionId: string,
  ): AssistantMessage | ToolMessage | SystemMessage | null {
    try {
      const obj = JSON.parse(line);
      if (obj.type === "system") {
        const message: SystemMessage = {
          id: obj.uuid,
          session_id: obj.session_id,
          role: "system",
          subtype: obj.subtype,
        };
        return message;
      } else if (obj.type === "assistant" || obj.type === "user") {
        let role: "assistant" | "tool" = "assistant";
        if (obj.type === "user" && containsToolResult(obj.message)) {
          role = "tool";
        } else {
          role = "assistant";
        }
        const message: AssistantMessage | ToolMessage = {
          id: obj.uuid,
          session_id: sessionId,
          role,
          content: obj.message.content,
        };
        // Carry token usage + resolved model on assistant turns so
        // downstream consumers can surface context-window occupancy and
        // which model served the turn. Claude streams both on each
        // `assistant` event under `message.usage` / `message.model`.
        if (role === "assistant") {
          if (obj.message?.usage) {
            const u = obj.message.usage;
            (message as AssistantMessage).usage = {
              input_tokens: u.input_tokens,
              output_tokens: u.output_tokens,
              cache_read_input_tokens: u.cache_read_input_tokens,
              cache_creation_input_tokens: u.cache_creation_input_tokens,
            };
          }
          // Skip Claude's `<synthetic>` placeholder model (compaction
          // notices and other locally-generated messages) so it never
          // leaks into the displayed model name.
          if (
            typeof obj.message?.model === "string" &&
            obj.message.model !== "<synthetic>"
          ) {
            (message as AssistantMessage).model = obj.message.model;
          }
        }
        return message;
      }
      return null;
    } catch {
      return null;
    }
  }
}

function containsToolResult(message: { content: MessageContent[] }): boolean {
  return message.content.some((content) => content.type === "tool_result");
}

/**
 * Keep only the trailing `maxChars` of `text` (errors surface at the end),
 * prefixing a marker noting how much was dropped. Returns `text` unchanged
 * when it already fits.
 */
function _clipTail(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const dropped = text.length - maxChars;
  return `… [${dropped} chars truncated]\n${text.slice(-maxChars)}`;
}

interface PermissionBridge {
  mcpConfigPath: string;
  cleanup: () => void;
}

function _buildPermissionBridge(
  message: UserMessage,
  options: AgentRunOptions,
): PermissionBridge | null {
  if (options.dangerouslySkipPermissions) return null;
  const chatId = message.chat_id;
  const channelId = message.channel_id;
  const initiatorOpenId = message.sender_open_id;
  const approvalUrl = Bun.env.AGENTARA_PERMISSION_URL;
  const approvalToken = Bun.env.AGENTARA_PERMISSION_TOKEN;
  if (!chatId || !channelId || !initiatorOpenId) return null;
  if (!approvalUrl || !approvalToken) return null;

  const scriptPath = _resolveMcpScriptPath();
  const mcpConfig = {
    mcpServers: {
      agentara: {
        command: "bun",
        args: ["run", scriptPath],
        env: {
          AGENTARA_APPROVAL_URL: approvalUrl,
          AGENTARA_APPROVAL_TOKEN: approvalToken,
          AGENTARA_SESSION_ID: message.session_id,
          AGENTARA_CHANNEL_ID: channelId,
          AGENTARA_CHAT_ID: chatId,
          AGENTARA_INITIATOR_OPEN_ID: initiatorOpenId,
          AGENTARA_REPLY_TO_MESSAGE_ID: message.id ?? "",
        },
      },
    },
  };
  const dir = mkdtempSync(join(tmpdir(), "agentara-claude-mcp-"));
  const mcpConfigPath = join(dir, `mcp-${randomUUID()}.json`);
  writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig));
  return {
    mcpConfigPath,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch (err) {
        logger.warn(
          { err, dir },
          "failed to clean up temp mcp-config dir",
        );
      }
    },
  };
}

/**
 * Absolute path to the stdio MCP server script. Resolved relative to
 * this file so it works both under `bun --watch run index.ts` (dev)
 * and from a bundled JS build where `import.meta.url` still points
 * inside the output dir.
 *
 * When shipping a `bun --compile` binary the .ts source won't exist
 * at that path at runtime — the caller would need to either keep the
 * source alongside the binary or switch to an inlined-string strategy.
 * Leaving a clear breadcrumb rather than silently failing.
 */
function _resolveMcpScriptPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "permission-mcp-server.ts");
}
