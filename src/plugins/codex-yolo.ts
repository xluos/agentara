import { CodexAgentRunner } from "@/community/openai";
import { registerRunner } from "@/kernel/agents";
import {
  type AgentRunOptions,
  type AgentRunner,
  type AssistantMessage,
  type SystemMessage,
  type ToolMessage,
  type UserMessage,
} from "@/shared";

const YOLO_PROXY = "http://127.0.0.1:7897";

/**
 * Codex runner variant matching the local shell helper:
 *
 *   HTTP_PROXY=http://127.0.0.1:7897
 *   HTTPS_PROXY=http://127.0.0.1:7897
 *   codex --search exec --dangerously-bypass-approvals-and-sandbox ...
 *
 * The base Codex runner already owns `exec`, JSON streaming, resume handling,
 * and the dangerous bypass flag, so this plugin only injects the fixed proxy
 * and the additional top-level `--search` CLI flag.
 */
class CodexYoloRunner implements AgentRunner {
  readonly type = "codex-yolo";
  private readonly _inner = new CodexAgentRunner({
    extraGlobalArgs: ["--search"],
  });

  async *stream(
    message: UserMessage,
    options: AgentRunOptions,
  ): AsyncIterableIterator<SystemMessage | AssistantMessage | ToolMessage> {
    yield* this._inner.stream(message, {
      ...options,
      envExtras: {
        ...(options.envExtras ?? {}),
        HTTP_PROXY: YOLO_PROXY,
        HTTPS_PROXY: YOLO_PROXY,
      },
    });
  }
}

registerRunner("codex-yolo", () => new CodexYoloRunner());
