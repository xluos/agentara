import { ClaudeAgentRunner } from "@/community/anthropic";
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

const _logger = createLogger("claude-gated");

/**
 * Wraps {@link ClaudeAgentRunner} with the safety preamble the user runs
 * in zshrc before invoking the real `claude` CLI:
 *
 *   1. Resolve a proxy URL (from `agents.env.HTTPS_PROXY` / `HTTP_PROXY`)
 *      and use it both for the country-detection fetch and for the
 *      delegated spawn's env.
 *   2. Call the IP-geolocation probes in {@link detectCountry} with a
 *      short timeout. Abort the dispatch if the country is not `US` or if
 *      every probe failed — we'd rather raise a clear error than let the
 *      agent burn tokens against a blocked egress.
 *   3. Delegate to the built-in Claude runner, carrying the proxy through
 *      via `envExtras` so the inner spawn actually goes through it, and
 *      force `--dangerously-skip-permissions` on — this wrapper exists for
 *      the unattended robot flow where the agent runs inside a controlled
 *      workspace, so per-tool approvals just stall the pipeline.
 *
 * Enable by setting `agents.default.type: "claude-gated"` in `config.yaml`.
 */
class ClaudeGatedRunner implements AgentRunner {
  readonly type = "claude-gated";
  private readonly _inner = new ClaudeAgentRunner();

  async *stream(
    message: UserMessage,
    options: AgentRunOptions,
  ): AsyncIterableIterator<SystemMessage | AssistantMessage | ToolMessage> {
    const proxy = _resolveProxy();

    const country = await detectCountry({ proxy });
    if (country === null) {
      throw new Error(
        "无法判定当前出口 IP 所在国家/地区，已拦截 Claude 启动（claude-gated）。",
      );
    }
    if (country !== "US") {
      throw new Error(
        `检测到当前出口 IP 不在美国（country=${country}），已拦截 Claude 启动（claude-gated）。`,
      );
    }
    _logger.info({ country }, "country gate passed");

    const mergedOptions: AgentRunOptions = {
      ...options,
      dangerouslySkipPermissions: true,
      ...(proxy
        ? {
            envExtras: {
              ...(options.envExtras ?? {}),
              HTTP_PROXY: proxy,
              HTTPS_PROXY: proxy,
            },
          }
        : {}),
    };

    yield* this._inner.stream(message, mergedOptions);
  }
}

function _resolveProxy(): string | undefined {
  const envMap = config.agents.env ?? {};
  return (
    envMap.HTTPS_PROXY ?? envMap.HTTP_PROXY ?? envMap.https_proxy ?? envMap.http_proxy
  );
}

registerRunner("claude-gated", () => new ClaudeGatedRunner());
