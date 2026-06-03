import { createLogger } from "@/shared";

const logger = createLogger("claude-usage");

/**
 * Account-level Claude usage snapshot returned by the Anthropic OAuth
 * usage endpoint. `utilization` values are percentages (`0..100`).
 */
export interface ClaudeUsage {
  five_hour: {
    utilization: number;
    resets_at: string | null;
  };
  seven_day: {
    utilization: number;
    resets_at: string;
  };
  extra_usage:
    | {
        is_enabled: true;
        monthly_limit: number;
        used_credits: number;
        utilization: number;
      }
    | {
        is_enabled: false;
        monthly_limit: null;
        used_credits: null;
        utilization: null;
      };
}

/**
 * Reads Claude Code credentials from the macOS Keychain via
 * `security find-generic-password`. Returns the stored value (a JSON
 * string) parsed as an object.
 */
async function getClaudeCredentials() {
  const proc = Bun.spawn(
    ["security", "find-generic-password", "-s", "Claude Code-credentials", "-w"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exit = await proc.exited;
  if (exit !== 0) {
    logger.warn({ exit, stderr }, "security find-generic-password failed");
    throw new Error(stderr || `security command exited with code ${exit}`);
  }
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new Error("empty credentials from keychain");
  }
  return JSON.parse(trimmed) as {
    claudeAiOauth: {
      accessToken: string;
      refreshToken: string;
      expiresAt: number;
    };
  };
}

/**
 * Fetches the current Claude usage / rate-limit snapshot from the
 * Anthropic OAuth usage endpoint using the locally stored subscription
 * credentials. Throws when credentials are missing or the request fails.
 */
export async function queryClaudeUsage(): Promise<ClaudeUsage> {
  const credentials = await getClaudeCredentials();
  const response = await fetch("https://api.anthropic.com/api/oauth/usage", {
    headers: new Headers({
      "anthropic-beta": "oauth-2025-04-20",
      Authorization: `Bearer ${credentials.claudeAiOauth.accessToken}`,
    }),
  });
  return (await response.json()) as ClaudeUsage;
}

interface UsageCacheEntry {
  at: number;
  data: ClaudeUsage;
}
let _usageCache: UsageCacheEntry | null = null;

/**
 * Cached variant of {@link queryClaudeUsage} for hot paths like rendering
 * a card footer on every reply. Serves a cached snapshot within `ttlMs`,
 * and on failure falls back to the last good snapshot (or `null`) instead
 * of throwing — the footer is best-effort and must never break a reply.
 *
 * @param ttlMs - Cache lifetime in milliseconds (default 60s).
 */
export async function getClaudeUsageCached(
  ttlMs = 60_000,
): Promise<ClaudeUsage | null> {
  const now = Date.now();
  if (_usageCache && now - _usageCache.at < ttlMs) {
    return _usageCache.data;
  }
  try {
    const data = await queryClaudeUsage();
    _usageCache = { at: now, data };
    return data;
  } catch (err) {
    logger.warn({ err }, "failed to query Claude usage; using last snapshot");
    return _usageCache?.data ?? null;
  }
}

/** Long-context ("1M") Claude window, in tokens. */
export const LONG_CONTEXT_TOKENS = 1_000_000;

/**
 * Context-window size (in tokens) assumed for the assistant's turns. The
 * configured models run on the 1M long-context window (the model id can't
 * be reliably mapped to a window — the config often leaves it unpinned and
 * the `1m` variant isn't reflected in the name), so we default to 1M. This
 * keeps the occupancy denominator stable across a whole conversation
 * instead of jumping mid-session.
 *
 * @param model - Resolved model id, accepted for forward-compat; unused.
 */
// eslint-disable-next-line no-unused-vars
export function contextLimitForModel(model?: string): number {
  return LONG_CONTEXT_TOKENS;
}
