import { z } from "zod";

/**
 * Configuration for a single agent.
 */
export const AgentConfig = z.object({
  type: z.string(),
  model: z.string().default("claude-sonnet-4-6"),
});
export interface AgentConfig extends z.infer<typeof AgentConfig> {}

/**
 * Codex CLI-specific runtime options.
 */
export const CodexConfig = z.object({
  /**
   * When `true`, agentara points spawned Codex at its own
   * `CODEX_HOME` so config / sessions / state / skills stay
   * separate from the host's `~/.codex/`.  Host `~/.codex/hooks.json`
   * is still loaded by Codex via its cwd-ancestor climb — move
   * that file out of `~/.codex/` yourself if you need it to skip
   * agentara workspaces.  Default `false` — agentara reuses the
   * host setup.
   */
  isolate_host_env: z.boolean().default(false),
});
export interface CodexConfig extends z.infer<typeof CodexConfig> {}

/**
 * Configuration for all agents.
 */
export const AgentsConfig = z.object({
  default: AgentConfig,
  codex: CodexConfig.default({ isolate_host_env: false }),
});
export interface AgentsConfig extends z.infer<typeof AgentsConfig> {}

/**
 * Configuration for task dispatching.
 */
export const TaskingConfig = z.object({
  max_retries: z.number().int().positive(),
});
export interface TaskingConfig extends z.infer<typeof TaskingConfig> {}

/**
 * Key-value parameters for a messaging channel. Accepts string, boolean,
 * number, or an array of the same in YAML (e.g. `require_mention: true`,
 * `allowed_user_ids: [ou_aaa, ou_bbb]`) and normalizes to strings so downstream
 * consumers always work with a uniform `Record<string, string>` shape. Arrays
 * are joined with commas — safe for identifiers that never contain commas
 * (open_id, union_id, etc.).
 */
export const ChannelParams = z.record(
  z.string(),
  z
    .union([
      z.string(),
      z.boolean(),
      z.number(),
      z.array(z.union([z.string(), z.boolean(), z.number()])),
    ])
    .transform((v) =>
      Array.isArray(v) ? v.map(String).join(",") : String(v),
    ),
);
export type ChannelParams = z.infer<typeof ChannelParams>;

/**
 * Configuration for a single messaging channel.
 */
export const ChannelConfig = z.object({
  id: z.string(),
  type: z.string(),
  name: z.string(),
  description: z.string(),
  params: ChannelParams,
});
export interface ChannelConfig extends z.infer<typeof ChannelConfig> {}

/**
 * Configuration for the messaging subsystem.
 */
export const MessagingConfig = z.object({
  default_channel_id: z.string(),
  channels: z.array(ChannelConfig),
});
export interface MessagingConfig extends z.infer<typeof MessagingConfig> {}

/**
 * Top-level application configuration loaded from config.yaml.
 *
 * The `/setup` catalog lives in `$AGENTARA_HOME/REPOS.md`, not here — see
 * `./predefined-repos.ts`.
 */
export const AppConfig = z.object({
  /** IANA timezone identifier, e.g. `"Asia/Shanghai"`. Defaults to the system timezone. */
  timezone: z
    .string()
    .default(Intl.DateTimeFormat().resolvedOptions().timeZone),
  agents: AgentsConfig,
  tasking: TaskingConfig,
  messaging: MessagingConfig,
});
export interface AppConfig extends z.infer<typeof AppConfig> {}
