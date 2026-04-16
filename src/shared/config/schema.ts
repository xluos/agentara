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
 * Configuration for all agents.
 */
export const AgentsConfig = z.object({
  default: AgentConfig,
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
 * A pre-defined repository surfaced by the `/init` command. Operators curate
 * this catalog in `config.yaml`; `/init` renders it as a Feishu interactive
 * card for the user to pick which repos (and branches) to clone into the
 * group's workspace.
 */
export const PredefinedRepo = z.object({
  name: z.string(),
  description: z.string().default(""),
  git_url: z.string(),
});
export interface PredefinedRepo extends z.infer<typeof PredefinedRepo> {}

/**
 * Top-level application configuration loaded from config.yaml.
 */
export const AppConfig = z.object({
  /** IANA timezone identifier, e.g. `"Asia/Shanghai"`. Defaults to the system timezone. */
  timezone: z
    .string()
    .default(Intl.DateTimeFormat().resolvedOptions().timeZone),
  agents: AgentsConfig,
  tasking: TaskingConfig,
  messaging: MessagingConfig,
  /** Optional catalog for `/init`. Empty/unset means the command is disabled. */
  predefined_repos: z.array(PredefinedRepo).default([]),
});
export interface AppConfig extends z.infer<typeof AppConfig> {}
