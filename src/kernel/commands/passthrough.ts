/**
 * Slash commands that are NOT handled by the gateway but are still
 * forwarded verbatim to the underlying agent CLI (Claude Code) instead of
 * being rejected as unknown. These are commands the CLI owns and can act
 * on in non-interactive `--print` / `--resume` mode.
 *
 * Everything outside this set that isn't a registered gateway/kernel
 * command falls back to the "unknown command" reply — passing arbitrary
 * `/typo` text to the LLM wastes a turn.
 *
 * Names are stored lowercase (matching {@link parseCommand}'s output).
 */
const PASSTHROUGH_COMMANDS = new Set<string>(["compact"]);

/**
 * Whether a parsed command name should be passed through to the agent.
 * @param name - Lowercase command name (no leading slash).
 */
export function isPassthroughCommand(name: string): boolean {
  return PASSTHROUGH_COMMANDS.has(name.toLowerCase());
}
