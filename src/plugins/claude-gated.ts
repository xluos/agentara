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

const _logger = createLogger("claude-gated");
const CLASH_CONTROLLER_SOCKET = "/tmp/verge/verge-mihomo.sock";
const HTTP_PROXY_CHECK_URL = "http://www.gstatic.com/generate_204";
const PROXY_READY_TIMEOUT_MS = 5000;

/**
 * Wraps {@link ClaudeAgentRunner} with the safety preamble the user runs
 * in zshrc before invoking the real `claude` CLI:
 *
 *   1. Resolve a proxy URL (from `agents.env.HTTPS_PROXY` / `HTTP_PROXY`)
 *      and use it both for the local proxy readiness check and for the
 *      delegated spawn's env.
 *   2. Check whether Clash Verge/Mihomo TUN is enabled, or whether the
 *      configured local HTTP proxy can fetch a lightweight connectivity URL.
 *      Abort only when both are unavailable.
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

    const readyVia = await _clashProxyReady(proxy);
    if (readyVia === null) {
      throw new Error(
        "Clash TUN 未开启，HTTP 代理也不可用，已拦截 Claude 启动（claude-gated）。",
      );
    }
    _logger.info({ readyVia }, "clash proxy gate passed");

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

async function _clashProxyReady(proxy: string | undefined): Promise<string | null> {
  if (await _isClashTunEnabled()) return "tun";
  if (proxy && (await _isHttpProxyReady(proxy))) return "http-proxy";
  return null;
}

async function _isClashTunEnabled(): Promise<boolean> {
  try {
    const result = await _runCurl(
      [
        "-fsS",
        "--unix-socket",
        CLASH_CONTROLLER_SOCKET,
        "http://localhost/configs",
      ],
      PROXY_READY_TIMEOUT_MS,
    );
    if (result.exitCode !== 0) return false;
    const configs = JSON.parse(result.stdout) as {
      tun?: { enable?: unknown };
    };
    return configs.tun?.enable === true;
  } catch (err) {
    _logger.debug({ err }, "clash tun readiness check failed");
    return false;
  }
}

async function _isHttpProxyReady(proxy: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROXY_READY_TIMEOUT_MS);
  try {
    const res = await fetch(HTTP_PROXY_CHECK_URL, {
      signal: controller.signal,
      proxy,
    } as RequestInit & { proxy: string });
    return res.status === 204 || res.ok;
  } catch (err) {
    _logger.debug({ err, proxy }, "http proxy readiness check failed");
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function _runCurl(
  args: string[],
  timeoutMs: number,
): Promise<{ exitCode: number; stdout: string }> {
  const proc = Bun.spawn(["curl", ...args], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  try {
    const [stdout, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    return { exitCode, stdout };
  } finally {
    clearTimeout(timer);
  }
}

function _resolveProxy(): string | undefined {
  const envMap = config.agents.env ?? {};
  return (
    envMap.HTTPS_PROXY ?? envMap.HTTP_PROXY ?? envMap.https_proxy ?? envMap.http_proxy
  );
}

registerRunner("claude-gated", () => new ClaudeGatedRunner());
