import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { config, createLogger } from "@/shared";

const _logger = createLogger("git-cache");

/**
 * On-disk object cache used as the `--reference` source when cloning
 * predefined repos into workspaces. Each entry is a bare mirror
 * (`git clone --mirror`) living at `$AGENTARA_HOME/git-cache/<name>.git/`,
 * maintained exclusively by agentara — users don't check out, commit,
 * or run `git gc` inside these mirrors, so the `--reference` dependents
 * can't have their objects pulled out from under them.
 *
 * Cache loss is survivable: callers fall back to a plain clone when
 * `ensureCachedMirror` returns `null`, so a broken or absent cache just
 * turns into "every clone is full again" — slow, but still correct.
 */

export interface GitCacheOptions {
  /** Override the cache root (tests). Defaults to `config.paths.git_cache`. */
  cacheRoot?: string;
  /** Per-git-process timeout in ms. Defaults to 5 minutes. */
  timeoutMs?: number;
}

const DEFAULT_CLONE_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_FETCH_TIMEOUT_MS = 2 * 60 * 1000;

/**
 * In-flight ensure operations keyed by absolute mirror path. Lets two
 * concurrent chats that first-touch the same repo share a single clone
 * process instead of racing on the target directory (the second clone
 * would fail with "destination path exists").
 */
const _inflight = new Map<string, Promise<string | null>>();

/**
 * Absolute path where the mirror for a given repo name lives, whether
 * or not it currently exists on disk.
 */
export function cachedMirrorPath(
  repoName: string,
  options: Pick<GitCacheOptions, "cacheRoot"> = {},
): string {
  const root = options.cacheRoot ?? config.paths.git_cache;
  return join(root, `${repoName}.git`);
}

/**
 * Lazily ensure a bare mirror exists for the given repo. Returns the
 * mirror path on success, or `null` on clone failure so callers can
 * decide whether to fall back. Concurrent calls for the same name
 * share a single clone process.
 */
export async function ensureCachedMirror(
  repo: { name: string; git_url: string },
  options: GitCacheOptions = {},
): Promise<string | null> {
  const mirror = cachedMirrorPath(repo.name, options);
  if (existsSync(mirror)) return mirror;

  const inflight = _inflight.get(mirror);
  if (inflight) return inflight;

  const task = _doClone(repo, mirror, options).finally(() => {
    _inflight.delete(mirror);
  });
  _inflight.set(mirror, task);
  return task;
}

/**
 * Best-effort `git fetch` on an existing mirror. No-op when the mirror
 * doesn't exist. Returns `true` on success, `false` on failure or
 * missing mirror; caller decides whether to surface to the user.
 */
export async function refreshCachedMirror(
  repoName: string,
  options: GitCacheOptions = {},
): Promise<boolean> {
  const mirror = cachedMirrorPath(repoName, options);
  if (!existsSync(mirror)) return false;
  const timeout = options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const res = await _execGit(["fetch", "--prune"], mirror, timeout);
  if (!res.ok) {
    _logger.warn(
      { repo: repoName, mirror, stderr: res.stderr },
      "cache mirror fetch failed",
    );
  }
  return res.ok;
}

async function _doClone(
  repo: { name: string; git_url: string },
  mirror: string,
  options: GitCacheOptions,
): Promise<string | null> {
  const root = options.cacheRoot ?? config.paths.git_cache;
  if (!existsSync(root)) mkdirSync(root, { recursive: true });
  const timeout = options.timeoutMs ?? DEFAULT_CLONE_TIMEOUT_MS;
  _logger.info({ repo: repo.name, mirror }, "seeding cache mirror");
  const res = await _execGit(
    ["clone", "--mirror", repo.git_url, `${repo.name}.git`],
    root,
    timeout,
  );
  if (!res.ok) {
    _logger.warn(
      { repo: repo.name, stderr: res.stderr },
      "cache mirror clone failed; caller will fall back to direct clone",
    );
    // Git may leave a partial dir behind on failure; wipe it so the
    // next attempt starts from a clean state instead of tripping over
    // "destination path already exists".
    try {
      if (existsSync(mirror)) rmSync(mirror, { recursive: true, force: true });
    } catch (err) {
      _logger.warn({ err, mirror }, "failed to clean up partial mirror dir");
    }
    return null;
  }
  return mirror;
}

async function _execGit(
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ ok: boolean; stdout: string; stderr: string; code: number }> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => {
    try {
      proc.kill();
    } catch {
      // process may already be gone
    }
  }, timeoutMs);
  try {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    return {
      ok: code === 0,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
      code,
    };
  } catch (err) {
    return { ok: false, stdout: "", stderr: String(err), code: -1 };
  } finally {
    clearTimeout(timer);
  }
}
