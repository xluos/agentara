import { homedir } from "node:os";
import { join } from "node:path";

import dayjs from "dayjs";

export const user_home = homedir();
export const home = Bun.env.AGENTARA_HOME || join(user_home, ".agentara");

export const sessions = join(home, "sessions");
export function resolveSessionFilePath(session_id: string) {
  return join(sessions, `${session_id}.jsonl`);
}

export const memory = join(home, "memory");
export const logs = join(memory, "logs");
export function resolveDailyLogFilePath(date: Date) {
  const dateString = dayjs(date).format("YYYY-MM-DD");
  return join(logs, `${dateString}.md`);
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
