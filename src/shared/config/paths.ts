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
 * Per-group workspace root container: `$AGENTARA_HOME/workspaces/<chat_id>/`.
 * `_default/` inside it is the fallback workspace for unbound groups.
 */
export const workspaces = join(home, "workspaces");
export const default_workspace = join(workspaces, "_default");
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
