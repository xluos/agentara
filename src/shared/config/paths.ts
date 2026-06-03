import { homedir } from "node:os";
import { join } from "node:path";

import dayjs from "dayjs";

export const user_home = homedir();
export const home = Bun.env.AGENTARA_HOME || join(user_home, ".agentara");

export const sessions = join(home, "sessions");
export function resolveSessionFilePath(session_id: string) {
  return join(sessions, `${session_id}.jsonl`);
}

export const repos_md = join(home, "REPOS.md");

export const memory = join(home, "memory");
export const logs = join(memory, "logs");
export function resolveDailyLogFilePath(date: Date) {
  const dateString = dayjs(date).format("YYYY-MM-DD");
  return join(logs, `${dateString}.md`);
}

/**
 * Runtime log files written alongside stdout by pino. One file per day,
 * `YYYY-MM-DD.log`. Conceptually distinct from `memory/logs/` (which stores
 * structured agent diaries); these are operational logs for debugging the
 * agentara process itself.
 */
export const runtime_logs = join(home, "runtime-logs");
export function resolveRuntimeLogFilePath(date: Date) {
  const dateString = dayjs(date).format("YYYY-MM-DD");
  return join(runtime_logs, `${dateString}.log`);
}

export const workspace = join(home, "workspace");
export const projects = join(workspace, "projects");
export const uploads = join(workspace, "uploads");
export const outputs = join(workspace, "outputs");

/**
 * Workspace root container: `$AGENTARA_HOME/workspaces/<workspace_id>/`.
 * `_default/` inside it is the fallback workspace for unbound groups.
 *
 * Each workspace directory is keyed by its stable `ws_xxx` id so the
 * human-readable `name` stays a pure display label — it can be renamed
 * at any time without moving files. `resolveWorkspacePathByName` stays
 * for diagnostics; `resolveGroupWorkspacePath` is kept only for legacy
 * bindings created before id-based paths existed and is normalized away
 * at boot.
 */
export const workspaces = join(home, "workspaces");
export const default_workspace = join(workspaces, "_default");

/**
 * Object-only cache of bare git mirrors, one per predefined repo name.
 * Used as the `--reference` source when cloning repos into workspaces so
 * object downloads are paid at most once across all workspaces. Never
 * used as a worktree or user-facing workspace — agentara maintains these
 * mirrors exclusively (clone, fetch). Losing this directory degrades to
 * "every clone is a fresh full clone" — still correct, just slower.
 */
export const git_cache = join(home, "git-cache");
export function resolveGitCachePath(repo_name: string) {
  return join(git_cache, `${repo_name}.git`);
}
export function resolveWorkspacePathById(workspace_id: string) {
  return join(workspaces, workspace_id);
}
export function resolveWorkspacePathByName(name: string) {
  return join(workspaces, name);
}
export function resolveGroupWorkspacePath(chat_id: string) {
  return join(workspaces, chat_id);
}

export const data = join(home, "data");
export function resolveDataFilePath(filename: string) {
  return join(data, filename);
}

export const claude_home = join(home, ".claude");
export const skills = join(claude_home, "skills");

export const agents_home = join(home, ".agents");

/**
 * Isolated `CODEX_HOME` for spawned Codex CLI processes.  Keeps
 * Codex's base config, sessions, state, and skills separate from
 * the host's `~/.codex/`.  Boot-loader seeds an `auth.json` symlink
 * so the OAuth login is shared bi-directionally.  Activated only
 * when `agents.codex.isolate_host_env` is `true`.
 */
export const codex_home = join(home, ".codex");
export const host_codex_home = join(user_home, ".codex");
