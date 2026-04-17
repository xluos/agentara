/**
 * Turn an arbitrary string (a Feishu group name, or whatever the user typed
 * into the `/setup` workspace-name input) into a safe directory name for
 * `$AGENTARA_HOME/workspaces/<name>/`.
 *
 * Design:
 * - Preserve CJK characters (common in group names) — keeping the directory
 *   human-readable matters more than strict ASCII.
 * - Collapse any whitespace run into a single `-`.
 * - Drop path separators (`/`, `\`), leading dots (would make the dir hidden
 *   or be interpreted as `.`/`..`), and any control characters.
 * - Trim leading/trailing separators/whitespace.
 * - Enforce a sensible length cap so shells/tools don't choke on the path.
 *
 * Returns an empty string if nothing usable survives; callers should fall
 * back to a deterministic chat-id-based name in that case.
 */
export function slugifyWorkspaceName(raw: string): string {
  if (!raw) return "";
  // eslint-disable-next-line no-control-regex
  let out = raw.replace(/[\u0000-\u001F\u007F]/g, "");
  out = out.replace(/\s+/g, "-");
  out = out.replace(/[\\/]/g, "-");
  // Strip characters that are dangerous or awkward as directory names.
  out = out.replace(/[<>:"|?*`$]/g, "");
  out = out.replace(/^[.\-_\s]+/, "");
  out = out.replace(/[.\-_\s]+$/, "");
  out = out.replace(/-{2,}/g, "-");
  if (out.length > 64) out = out.slice(0, 64).replace(/-+$/, "");
  return out;
}
