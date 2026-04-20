import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { createLogger } from "@/shared";

const _logger = createLogger("git-sync");

export interface RepoSyncState {
  /** Repo directory name under the workspace root. */
  name: string;
  /** Absolute path to the repo. */
  path: string;
  /** Current branch; `undefined` for detached HEAD. */
  branch?: string;
  /** Name of the upstream branch (e.g. `origin/master`), when configured. */
  upstream?: string;
  /** Commits on the local branch not yet on upstream. */
  ahead: number;
  /** Commits on upstream not yet on the local branch. */
  behind: number;
  /** True when the working tree has uncommitted changes. */
  dirty: boolean;
}

export type PullStatus =
  /** `git fetch` + `git pull --ff-only` succeeded (may be a no-op if already up-to-date). */
  | "up_to_date"
  | "fast_forwarded"
  /** Fetch worked but pull was skipped because the tree was dirty or diverged. */
  | "skipped_dirty"
  | "skipped_diverged"
  /** No upstream configured — there's nothing to pull from. */
  | "no_upstream"
  /** Detached HEAD — there's no branch to pull into. */
  | "detached"
  /** The network / `git` process failed. */
  | "fetch_failed"
  | "pull_failed";

export interface RepoSyncResult {
  name: string;
  path: string;
  branch?: string;
  /** Ahead/behind after the (attempted) sync, so /sync output reflects current truth. */
  ahead: number;
  behind: number;
  status: PullStatus;
  /** Short commit SHAs before/after on status `fast_forwarded`. */
  before_sha?: string;
  after_sha?: string;
  /** Short human-readable detail on failure/skip paths. */
  detail?: string;
}

export interface SyncOptions {
  /**
   * Whether to attempt `git pull --ff-only` after fetch. When false, only the
   * fetch is performed and ahead/behind is refreshed without touching the
   * working tree. Defaults to true.
   */
  pull?: boolean;
  /**
   * Per-repo timeout budget in ms. Individual git processes get at most this
   * long before we kill them and record a failure — keeps a flaky network
   * from hanging session start forever. Defaults to 20_000.
   */
  timeout_ms?: number;
}

/**
 * Fire a fetch + optional ff-only pull for every git repo under `workspacePath`.
 * Safe to run concurrently with an active agent: fetch never touches the
 * working tree, and ff-only pull is atomic and refuses to run on dirty /
 * diverged repos. Returns one result per repo — callers decide how to
 * format (e.g. /sync writes a summary; session-start logs silently).
 */
export async function syncWorkspace(
  workspacePath: string,
  options: SyncOptions = {},
): Promise<RepoSyncResult[]> {
  const repos = listRepos(workspacePath);
  const results: RepoSyncResult[] = [];
  for (const repo of repos) {
    results.push(await syncRepo(repo.path, options));
  }
  return results;
}

/**
 * Sync a single repo. See {@link syncWorkspace} for semantics.
 */
export async function syncRepo(
  repoPath: string,
  options: SyncOptions = {},
): Promise<RepoSyncResult> {
  const pull = options.pull !== false;
  const timeout = options.timeout_ms ?? 20_000;
  const name = _basename(repoPath);
  const branch = await _readCurrentBranch(repoPath);

  const fetch = await _execGit(
    ["fetch", "--prune", "origin"],
    repoPath,
    timeout,
  );
  if (!fetch.ok) {
    const state = await _readState(repoPath);
    return {
      name,
      path: repoPath,
      branch,
      ahead: state.ahead,
      behind: state.behind,
      status: "fetch_failed",
      detail: _compressErr(fetch.stderr || fetch.stdout),
    };
  }

  if (!branch) {
    const state = await _readState(repoPath);
    return {
      name,
      path: repoPath,
      ahead: state.ahead,
      behind: state.behind,
      status: "detached",
    };
  }

  const upstream = await _readUpstream(repoPath);
  if (!upstream) {
    return {
      name,
      path: repoPath,
      branch,
      ahead: 0,
      behind: 0,
      status: "no_upstream",
    };
  }

  const state = await _readState(repoPath);

  if (!pull) {
    return {
      name,
      path: repoPath,
      branch,
      ahead: state.ahead,
      behind: state.behind,
      status: state.behind === 0 ? "up_to_date" : "up_to_date",
    };
  }

  if (state.dirty) {
    return {
      name,
      path: repoPath,
      branch,
      ahead: state.ahead,
      behind: state.behind,
      status: "skipped_dirty",
      detail: "working tree has uncommitted changes",
    };
  }
  if (state.ahead > 0 && state.behind > 0) {
    return {
      name,
      path: repoPath,
      branch,
      ahead: state.ahead,
      behind: state.behind,
      status: "skipped_diverged",
      detail: `local has ${state.ahead} commit(s) not on upstream`,
    };
  }
  if (state.behind === 0) {
    return {
      name,
      path: repoPath,
      branch,
      ahead: state.ahead,
      behind: 0,
      status: "up_to_date",
    };
  }

  const before = await _readHeadSha(repoPath);
  const pullRes = await _execGit(
    ["pull", "--ff-only", "--no-rebase"],
    repoPath,
    timeout,
  );
  if (!pullRes.ok) {
    return {
      name,
      path: repoPath,
      branch,
      ahead: state.ahead,
      behind: state.behind,
      status: "pull_failed",
      detail: _compressErr(pullRes.stderr || pullRes.stdout),
    };
  }
  const after = await _readHeadSha(repoPath);
  const postState = await _readState(repoPath);
  return {
    name,
    path: repoPath,
    branch,
    ahead: postState.ahead,
    behind: postState.behind,
    status: "fast_forwarded",
    before_sha: before,
    after_sha: after,
  };
}

/**
 * Read the sync state of every git repo under `workspacePath` without doing
 * any network work. Used by `/status` to render the ahead/behind indicators
 * from the most recent fetch's locally-known upstream refs.
 */
export function listRepoSyncState(workspacePath: string): RepoSyncState[] {
  return listRepos(workspacePath).map((r) => {
    const branch = _readCurrentBranchSync(r.path);
    const upstream = _readUpstreamSync(r.path);
    const ahead = upstream ? _readAheadSync(r.path) : 0;
    const behind = upstream ? _readBehindSync(r.path) : 0;
    const dirty = _readDirtySync(r.path);
    return {
      name: r.name,
      path: r.path,
      branch,
      upstream,
      ahead,
      behind,
      dirty,
    };
  });
}

/**
 * Read the current branch of a single repo (HEAD). Returns `undefined` when
 * the repo is in a detached-HEAD state or git exits non-zero. Thin wrapper
 * around the internal sync helper so other layers don't have to shell out
 * themselves.
 */
export function readRepoHead(repoPath: string): string | undefined {
  return _readCurrentBranchSync(repoPath);
}

/**
 * Render `↑a ↓b` for ahead/behind counts, omitting zero sides. Returns an
 * empty string when both sides are zero. Callers usually concatenate this
 * after a `repo branch` code block.
 */
export function formatAheadBehind(ahead: number, behind: number): string {
  const parts: string[] = [];
  if (ahead > 0) parts.push(`↑${ahead}`);
  if (behind > 0) parts.push(`↓${behind}`);
  return parts.join(" ");
}

function listRepos(
  workspacePath: string,
): Array<{ name: string; path: string }> {
  if (!existsSync(workspacePath)) return [];
  try {
    return readdirSync(workspacePath)
      .filter((name) => !name.startsWith("."))
      .map((name) => ({ name, path: join(workspacePath, name) }))
      .filter((r) => {
        try {
          return statSync(r.path).isDirectory() && existsSync(join(r.path, ".git"));
        } catch {
          return false;
        }
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
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
      // ignore — process may already be gone
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
    _logger.warn({ err, args, cwd }, "git exec threw");
    return { ok: false, stdout: "", stderr: String(err), code: -1 };
  } finally {
    clearTimeout(timer);
  }
}

async function _readCurrentBranch(repoPath: string): Promise<string | undefined> {
  const res = await _execGit(
    ["rev-parse", "--abbrev-ref", "HEAD"],
    repoPath,
    5000,
  );
  if (!res.ok) return undefined;
  const out = res.stdout;
  return out && out !== "HEAD" ? out : undefined;
}

async function _readUpstream(repoPath: string): Promise<string | undefined> {
  const res = await _execGit(
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    repoPath,
    5000,
  );
  return res.ok && res.stdout ? res.stdout : undefined;
}

async function _readHeadSha(repoPath: string): Promise<string | undefined> {
  const res = await _execGit(["rev-parse", "--short=12", "HEAD"], repoPath, 5000);
  return res.ok ? res.stdout : undefined;
}

async function _readState(
  repoPath: string,
): Promise<{ ahead: number; behind: number; dirty: boolean }> {
  const counts = await _execGit(
    ["rev-list", "--left-right", "--count", "HEAD...@{u}"],
    repoPath,
    5000,
  );
  let ahead = 0;
  let behind = 0;
  if (counts.ok) {
    const [a, b] = counts.stdout.split(/\s+/);
    ahead = parseInt(a ?? "0", 10) || 0;
    behind = parseInt(b ?? "0", 10) || 0;
  }
  const dirtyRes = await _execGit(
    ["status", "--porcelain"],
    repoPath,
    5000,
  );
  const dirty = dirtyRes.ok && dirtyRes.stdout.length > 0;
  return { ahead, behind, dirty };
}

function _execGitSync(
  args: string[],
  cwd: string,
): { ok: boolean; stdout: string } {
  try {
    const proc = Bun.spawnSync(["git", ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = proc.stdout.toString().trim();
    return { ok: proc.exitCode === 0, stdout };
  } catch {
    return { ok: false, stdout: "" };
  }
}

function _readCurrentBranchSync(repoPath: string): string | undefined {
  const res = _execGitSync(
    ["rev-parse", "--abbrev-ref", "HEAD"],
    repoPath,
  );
  if (!res.ok) return undefined;
  return res.stdout && res.stdout !== "HEAD" ? res.stdout : undefined;
}

function _readUpstreamSync(repoPath: string): string | undefined {
  const res = _execGitSync(
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    repoPath,
  );
  return res.ok && res.stdout ? res.stdout : undefined;
}

function _readAheadSync(repoPath: string): number {
  const res = _execGitSync(
    ["rev-list", "--count", "@{u}..HEAD"],
    repoPath,
  );
  return res.ok ? parseInt(res.stdout, 10) || 0 : 0;
}

function _readBehindSync(repoPath: string): number {
  const res = _execGitSync(
    ["rev-list", "--count", "HEAD..@{u}"],
    repoPath,
  );
  return res.ok ? parseInt(res.stdout, 10) || 0 : 0;
}

function _readDirtySync(repoPath: string): boolean {
  const res = _execGitSync(["status", "--porcelain"], repoPath);
  return res.ok && res.stdout.length > 0;
}

function _basename(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, "");
  const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

function _compressErr(detail: string): string {
  const first = detail.split("\n").find((l) => l.trim()) ?? "";
  return first.length > 160 ? first.slice(0, 160) + "…" : first;
}
