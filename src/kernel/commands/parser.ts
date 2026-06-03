import type { ParsedCommand } from "./types";

/**
 * Parse a message body into a slash command. Returns null when the text
 * doesn't start with `/` or is a single slash. Command name is normalized
 * to lowercase; args are split on whitespace runs.
 *
 * Note: `/stop` is reserved for the kernel's task-cancel path and is
 * handled before this parser is consulted.
 */
export function parseCommand(text: string): ParsedCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/") || trimmed.length < 2) return null;
  const body = trimmed.slice(1);
  const parts = body.split(/\s+/);
  const name = parts[0]?.toLowerCase();
  if (!name) return null;
  return {
    name,
    args: parts.slice(1),
    raw: trimmed,
  };
}
