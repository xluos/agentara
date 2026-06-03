import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  config,
  createLogger,
  extractTextContent,
  inlineMentions,
  resolveInstructionFile,
  uuid,
  type ToolMessage,
  type AgentRunner,
  type AgentRunOptions,
  type AssistantMessage,
  type SystemMessage,
  type UserMessage,
} from "@/shared";

const logger = createLogger("codex-agent-runner");

export interface CodexAgentRunnerOptions {
  extraGlobalArgs?: string[];
  extraExecArgs?: string[];
}

interface CodexSpawnOptions {
  args: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  signal?: AbortSignal;
  sessionId: string;
}

/**
 * Error thrown when the agent runner is aborted.
 */
export class AgentAbortError extends Error {
  constructor(message = "Agent execution was aborted") {
    super(message);
    this.name = "AgentAbortError";
  }
}

export class CodexMissingResumeError extends Error {
  readonly causeError: unknown;

  constructor(
    readonly resumeId: string,
    causeError: unknown,
  ) {
    super(
      `Codex 无法续接本地 thread：${resumeId}。请确认是否重新开始 Codex 会话。`,
    );
    this.name = "CodexMissingResumeError";
    this.causeError = causeError;
  }
}

/**
 * The agent runner for OpenAI Codex CLI.
 *
 * Spawns `codex exec --json --dangerously-bypass-approvals-and-sandbox`
 * and parses the JSONL event stream produced by the Codex CLI into the
 * Agentara message types.
 */
export class CodexAgentRunner implements AgentRunner {
  readonly type = "codex";
  private readonly _options: CodexAgentRunnerOptions;

  constructor(options: CodexAgentRunnerOptions = {}) {
    this._options = options;
  }

  async *stream(
    message: UserMessage,
    options: AgentRunOptions,
  ): AsyncIterableIterator<SystemMessage | AssistantMessage | ToolMessage> {
    const sessionId = message.session_id;
    const isNew = options?.isNewSession ?? false;
    const signal = options?.signal;
    const resumeId = options.runnerSessionId ?? sessionId;
    const textContentOfUserMessage = JSON.stringify(
      inlineMentions(extractTextContent(message), message.mentions),
    );

    // Sync CLAUDE.md → AGENTS.md on every invocation so Codex CLI always
    // picks up the latest content (e.g. updated @memory/USER.md).
    this._syncAgentsMd(options.cwd);

    const args = this._buildExecArgs({
      isNew,
      resumeId,
      prompt: textContentOfUserMessage,
    });

    // Gated by `agents.codex.isolate_host_env` — off by default,
    // in which case Codex inherits the host env verbatim.  When on,
    // CODEX_HOME is redirected so config / sessions / state stay
    // separate from the host's `~/.codex/`.  Host hook behavior is
    // not touched here — Codex always climbs cwd ancestors for
    // `.codex/hooks.json` regardless of CODEX_HOME, so keep your
    // global hooks.json out of `~/.codex/` if you do not want it
    // firing under agentara workspaces.
    const isolationEnv = config.agents.codex.isolate_host_env
      ? { CODEX_HOME: config.paths.codex_home }
      : {};
    const env = {
      ...Bun.env,
      ...config.agents.env,
      ...isolationEnv,
      ...(options.envExtras ?? {}),
    };

    try {
      yield* this._streamCodexProcess({
        args,
        cwd: options.cwd,
        env,
        signal,
        sessionId,
      });
    } catch (err) {
      if (!isNew && this._isMissingResumeError(err)) {
        throw new CodexMissingResumeError(resumeId, err);
      }
      throw err;
    }
  }

  private async *_streamCodexProcess(
    options: CodexSpawnOptions,
  ): AsyncIterableIterator<SystemMessage | AssistantMessage | ToolMessage> {
    const proc = Bun.spawn(options.args, {
      cwd: options.cwd,
      env: options.env,
      stderr: "pipe",
    });
    // Handle abort signal
    let aborted = false;
    const abortHandler = () => {
      aborted = true;
      logger.info(
        { session_id: options.sessionId },
        "killing Codex CLI process",
      );
      proc.kill();
    };
    if (options.signal) {
      if (options.signal.aborted) {
        proc.kill();
        throw new AgentAbortError();
      }
      options.signal.addEventListener("abort", abortHandler, { once: true });
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
            const messages = this._parseStreamLine(
              line.trim(),
              options.sessionId,
            );
            for (const msg of messages) {
              yield msg;
            }
          }
        }
      }

      if (!aborted && buffer.trim()) {
        const messages = this._parseStreamLine(buffer.trim(), options.sessionId);
        for (const msg of messages) {
          yield msg;
        }
      }
    } finally {
      if (options.signal) {
        options.signal.removeEventListener("abort", abortHandler);
      }
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
      throw new CodexCliExitError(exitCode, stdoutRaw, stderrText);
    }
  }

  /**
   * Parses a single JSONL line from Codex CLI `exec --json` output
   * and maps it to zero or more Agentara messages.
   */
  _parseStreamLine(
    line: string,
    sessionId: string,
  ): Array<AssistantMessage | ToolMessage | SystemMessage> {
    try {
      const obj = JSON.parse(line);
      return this._mapEvent(obj, sessionId);
    } catch {
      return [];
    }
  }

  private _mapEvent(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    event: any,
    sessionId: string,
  ): Array<AssistantMessage | ToolMessage | SystemMessage> {
    const type: string | undefined = event?.type;
    if (!type) return [];

    switch (type) {
      case "thread.started": {
        const threadId: string = event.thread_id ?? sessionId;
        return [
          {
            id: threadId,
            session_id: sessionId,
            role: "system" as const,
            subtype: "init",
          },
        ];
      }

      case "item.started":
      case "item.updated":
      case "item.completed": {
        return this._mapItemEvent(event, sessionId);
      }

      case "turn.failed": {
        const errorMsg = event.error?.message ?? "Unknown turn failure";
        return [
          {
            id: uuid(),
            session_id: sessionId,
            role: "assistant" as const,
            content: [{ type: "text" as const, text: `Error: ${errorMsg}` }],
          },
        ];
      }

      case "error": {
        const errorMsg = event.message ?? "Unknown stream error";
        return [
          {
            id: uuid(),
            session_id: sessionId,
            role: "assistant" as const,
            content: [{ type: "text" as const, text: `Error: ${errorMsg}` }],
          },
        ];
      }

      default:
        return [];
    }
  }

  private _mapItemEvent(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    event: any,
    sessionId: string,
  ): Array<AssistantMessage | ToolMessage | SystemMessage> {
    const item = event.item;
    if (!item) return [];

    const itemId: string = item.id ?? uuid();
    const itemType: string | undefined = item.type;
    const eventType: string = event.type;

    switch (itemType) {
      case "agent_message": {
        if (eventType !== "item.completed") return [];
        return [
          {
            id: itemId,
            session_id: sessionId,
            role: "assistant" as const,
            content: [{ type: "text" as const, text: item.text ?? "" }],
          },
        ];
      }

      case "reasoning": {
        if (eventType !== "item.completed") return [];
        return [
          {
            id: itemId,
            session_id: sessionId,
            role: "assistant" as const,
            content: [
              { type: "thinking" as const, thinking: item.text ?? "" },
            ],
          },
        ];
      }

      case "command_execution": {
        if (eventType === "item.started") {
          return [
            {
              id: itemId,
              session_id: sessionId,
              role: "assistant" as const,
              content: [
                {
                  type: "tool_use" as const,
                  name: "Bash",
                  id: itemId,
                  input: { command: item.command ?? "" },
                },
              ],
            },
          ];
        }
        if (eventType === "item.completed") {
          return [
            {
              id: `${itemId}-result`,
              session_id: sessionId,
              role: "tool" as const,
              content: [
                {
                  type: "tool_result" as const,
                  tool_use_id: itemId,
                  content: item.aggregated_output ?? "",
                },
              ],
            },
          ];
        }
        return [];
      }

      case "file_change": {
        if (eventType !== "item.completed") return [];
        const changes: Array<{ path: string; kind: string }> =
          item.changes ?? [];
        const filePath = this._formatFileChangePath(changes);
        return [
          {
            id: itemId,
            session_id: sessionId,
            role: "assistant" as const,
            content: [
              {
                type: "tool_use" as const,
                name: "Edit",
                id: itemId,
                input: { file_path: filePath },
              },
            ],
          },
          {
            id: `${itemId}-result`,
            session_id: sessionId,
            role: "tool" as const,
            content: [
              {
                type: "tool_result" as const,
                tool_use_id: itemId,
                content:
                  item.status === "completed"
                    ? "File changes applied successfully"
                    : `File changes ${item.status ?? "unknown"}`,
              },
            ],
          },
        ];
      }

      case "mcp_tool_call": {
        if (eventType === "item.started") {
          return [
            {
              id: itemId,
              session_id: sessionId,
              role: "assistant" as const,
              content: [
                {
                  type: "tool_use" as const,
                  name: `${item.server ?? "mcp"}__${item.tool ?? "unknown"}`,
                  id: itemId,
                  input: item.arguments ?? {},
                },
              ],
            },
          ];
        }
        if (eventType === "item.completed") {
          const resultText = item.result?.content
            ? JSON.stringify(item.result.content)
            : item.error?.message ?? "";
          return [
            {
              id: `${itemId}-result`,
              session_id: sessionId,
              role: "tool" as const,
              content: [
                {
                  type: "tool_result" as const,
                  tool_use_id: itemId,
                  content: resultText,
                },
              ],
            },
          ];
        }
        return [];
      }

      case "web_search": {
        if (eventType !== "item.completed") return [];
        const query = this._resolveWebSearchQuery(item);
        if (!query) {
          return [];
        }
        return [
          {
            id: itemId,
            session_id: sessionId,
            role: "assistant" as const,
            content: [
              {
                type: "tool_use" as const,
                name: "WebSearch",
                id: itemId,
                input: { query },
              },
            ],
          },
          {
            id: `${itemId}-result`,
            session_id: sessionId,
            role: "tool" as const,
            content: [
              {
                type: "tool_result" as const,
                tool_use_id: itemId,
                content: `Web search completed for: ${query}`,
              },
            ],
          },
        ];
      }

      case "error": {
        return [
          {
            id: itemId,
            session_id: sessionId,
            role: "assistant" as const,
            content: [
              {
                type: "text" as const,
                text: `Error: ${item.message ?? "Unknown error"}`,
              },
            ],
          },
        ];
      }

      default:
        return [];
    }
  }

  private _formatFileChangePath(
    changes: Array<{ path: string; kind: string }>,
  ): string {
    const paths = changes
      .map((change) => change.path?.trim())
      .filter((path): path is string => Boolean(path));

    if (paths.length === 0) {
      return "(unknown file)";
    }
    if (paths.length === 1) {
      return paths[0]!;
    }
    return `${paths[0]} (+${paths.length - 1} more)`;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _resolveWebSearchQuery(item: any): string | undefined {
    const candidates = [
      item?.query,
      item?.search_query,
      item?.input?.query,
      item?.arguments?.query,
      item?.payload?.query,
      item?.action?.query,
    ];

    for (const candidate of candidates) {
      if (typeof candidate === "string" && candidate.trim() !== "") {
        return candidate.trim();
      }
    }

    return undefined;
  }

  private _buildExecArgs({
    isNew,
    resumeId,
    prompt,
  }: {
    isNew: boolean;
    resumeId: string;
    prompt: string;
  }): string[] {
    const configuredModel = config.agents.default.model;
    const shared = [
      "codex",
      ...(this._options.extraGlobalArgs ?? []),
      "exec",
      // Only pin the model when config names one; otherwise Codex CLI
      // picks its own default (user omitted `model` in config.yaml).
      ...(configuredModel ? ["--model", configuredModel] : []),
      "--json",
      "--dangerously-bypass-approvals-and-sandbox",
      "--skip-git-repo-check",
      ...(this._options.extraExecArgs ?? []),
    ];
    if (isNew) {
      return [...shared, prompt];
    }
    return [...shared, "resume", resumeId, prompt];
  }

  private _isMissingResumeError(err: unknown): boolean {
    if (!(err instanceof CodexCliExitError)) return false;
    return this._isMissingResumeErrorText(err.stderr);
  }

  private _isMissingResumeErrorText(text: string): boolean {
    return (
      text.includes("thread/resume failed") &&
      text.includes("no rollout found for thread id")
    );
  }

  /**
   * Reads `CLAUDE.md` from `cwd`, resolves any `@path/file` imports, and
   * writes the result as `AGENTS.md` so the Codex CLI can pick it up as its
   * native instruction file.  Skips the write when the content is unchanged
   * to avoid unnecessary filesystem churn.
   */
  private _syncAgentsMd(cwd: string): void {
    try {
      const claudeMdPath = join(cwd, "CLAUDE.md");
      if (!existsSync(claudeMdPath)) {
        return;
      }

      const resolved = resolveInstructionFile(claudeMdPath, cwd);
      if (!resolved) {
        return;
      }
      const normalized = resolved.replaceAll("Claude Code", "Codex");

      const agentsMdPath = join(cwd, "AGENTS.md");

      // Skip write when contents are identical to avoid file-watcher churn.
      if (existsSync(agentsMdPath)) {
        const existing = readFileSync(agentsMdPath, "utf-8");
        if (existing === normalized) {
          return;
        }
      }

      writeFileSync(agentsMdPath, normalized, "utf-8");
      logger.info("Synced CLAUDE.md → AGENTS.md (with resolved imports)");
    } catch (err) {
      logger.warn({ err }, "Failed to sync CLAUDE.md → AGENTS.md");
    }
  }
}

class CodexCliExitError extends Error {
  constructor(
    readonly exitCode: number,
    readonly stdout: string,
    readonly stderr: string,
  ) {
    const parts: string[] = [];
    if (stdout.trim()) {
      parts.push(`Stdout:\n${stdout.trim()}`);
    }
    if (stderr.trim()) {
      parts.push(`Stderr:\n${stderr.trim()}`);
    }
    const detail = parts.length > 0 ? `\n\n${parts.join("\n\n")}` : "";
    super(`Codex CLI exited with code ${exitCode}${detail}`);
    this.name = "CodexCliExitError";
  }
}
