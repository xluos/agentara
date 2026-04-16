import { readFileSync } from "node:fs";
import { join } from "node:path";

import { resolveEnvVars } from "./env-resolver";
import * as paths from "./paths";
import type { AppConfig } from "./schema";
import { AppConfig as AppConfigSchema } from "./schema";

export type {
  AgentConfig,
  AgentsConfig,
  AppConfig,
  ChannelConfig,
  ChannelParams,
  CodexConfig,
  MessagingConfig,
  TaskingConfig,
} from "./schema";

export { loadPredefinedRepos, PredefinedRepo } from "./predefined-repos";

/**
 * Combined configuration interface including both YAML-loaded app config and paths.
 */
export interface Config extends AppConfig {
  paths: typeof paths;
}

let _appConfig: AppConfig | null = null;

/**
 * Loads the application configuration from `$AGENTARA_HOME/config.yaml`.
 * Parses the YAML, resolves `$ENV_VAR` references, and validates against the schema.
 */
function _loadConfigFromFile(): AppConfig {
  const configPath = join(paths.home, "config.yaml");
  const raw = readFileSync(configPath, "utf-8");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Bun.YAML.parse is not yet in TS types
  const parsed = (Bun as any).YAML.parse(raw);
  const resolved = resolveEnvVars(parsed);
  return AppConfigSchema.parse(resolved);
}

/**
 * Reloads the application configuration from disk.
 * Call this after generating or modifying `config.yaml`.
 */
export function reloadConfig(): void {
  _appConfig = _loadConfigFromFile();
}

// Attempt initial load — swallow error so boot-loader can use config.paths before yaml exists.
try {
  _appConfig = _loadConfigFromFile();
} catch {
  // config.yaml may not exist yet; boot-loader will call reloadConfig() after generating it.
}

/**
 * The global application configuration object.
 * `paths` is always available. Other properties require `config.yaml` to be loaded.
 */
export const config = {
  get timezone() {
    if (!_appConfig) {
      return Intl.DateTimeFormat().resolvedOptions().timeZone;
    }
    return _appConfig.timezone;
  },
  get agents() {
    if (!_appConfig) {
      throw new Error(
        "config.yaml has not been loaded yet. Call reloadConfig() first.",
      );
    }
    return _appConfig.agents;
  },
  get tasking() {
    if (!_appConfig) {
      throw new Error(
        "config.yaml has not been loaded yet. Call reloadConfig() first.",
      );
    }
    return _appConfig.tasking;
  },
  get messaging() {
    if (!_appConfig) {
      throw new Error(
        "config.yaml has not been loaded yet. Call reloadConfig() first.",
      );
    }
    return _appConfig.messaging;
  },
  paths,
};
