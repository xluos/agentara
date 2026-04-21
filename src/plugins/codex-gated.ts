import { CodexAgentRunner } from "@/community/openai";
import { registerRunner } from "@/kernel/agents";
import {
  config,
  createLogger,
  type AgentRunOptions,
  type AgentRunner,
  type AssistantMessage,
  type SystemMessage,
  type ToolMessage,
  type UserMessage,
} from "@/shared";

import { detectCountry } from "./_country-check";

const _logger = createLogger("codex-gated");

/**
 * Symmetric counterpart to {@link import("./claude-gated").default}: same
 * country-gate + proxy-injection preamble, wrapping Codex instead of
 * Claude. Codex already ships with `--dangerously-bypass-approvals-and-sandbox`
 * baked in at the built-in runner level, so no extra CLI flag layering is
 * needed here — the plugin's job is purely egress guarding.
 *
 * Enable by setting `agents.default.type: "codex-gated"` in `config.yaml`.
 */
class CodexGatedRunner implements AgentRunner {
  readonly type = "codex-gated";
  private readonly _inner = new CodexAgentRunner();

  async *stream(
    message: UserMessage,
    options: AgentRunOptions,
  ): AsyncIterableIterator<SystemMessage | AssistantMessage | ToolMessage> {
    const proxy = _resolveProxy();

    const country = await detectCountry({ proxy });
    if (country === null) {
      throw new Error(
        "无法判定当前出口 IP 所在国家/地区，已拦截 Codex 启动（codex-gated）。",
      );
    }
    if (country !== "US") {
      throw new Error(
        `检测到当前出口 IP 不在美国（country=${country}），已拦截 Codex 启动（codex-gated）。`,
      );
    }
    _logger.info({ country }, "country gate passed");

    const mergedOptions: AgentRunOptions = proxy
      ? {
          ...options,
          envExtras: {
            ...(options.envExtras ?? {}),
            HTTP_PROXY: proxy,
            HTTPS_PROXY: proxy,
          },
        }
      : options;

    yield* this._inner.stream(message, mergedOptions);
  }
}

function _resolveProxy(): string | undefined {
  const envMap = config.agents.env ?? {};
  return (
    envMap.HTTPS_PROXY ?? envMap.HTTP_PROXY ?? envMap.https_proxy ?? envMap.http_proxy
  );
}

registerRunner("codex-gated", () => new CodexGatedRunner());
