import { createLogger, type AgentRunner } from "@/shared";

const _logger = createLogger("agent-registry");

/**
 * Factory that produces a fresh `AgentRunner` instance. Deferred so
 * registration can happen at module-load time without paying the cost of
 * constructing runners that are never used.
 */
type RunnerFactory = () => AgentRunner;

const _runners = new Map<string, RunnerFactory>();

/**
 * Register a runner under a type name. Later registrations with the same
 * type overwrite — useful for plugins that wrap/replace a built-in.
 */
export function registerRunner(type: string, factory: RunnerFactory): void {
  const overwrite = _runners.has(type);
  _runners.set(type, factory);
  if (overwrite) {
    _logger.info({ type }, "runner type re-registered (overwrite)");
  } else {
    _logger.info({ type }, "runner type registered");
  }
}

/**
 * Create a runner instance for the given type. Throws when no runner is
 * registered under the name — the caller is expected to surface a clear
 * error to the user (e.g. "check `agents.default.type` in config.yaml").
 */
export function createRunner(type: string): AgentRunner {
  const factory = _runners.get(type);
  if (!factory) {
    const known = Array.from(_runners.keys()).join(", ") || "<none>";
    throw new Error(
      `Unknown agent runner type: \`${type}\`. Known types: ${known}.`,
    );
  }
  return factory();
}

/**
 * List currently-registered runner types. Intended for diagnostics /
 * `/help`-style surfaces; order is insertion order.
 */
export function listRunnerTypes(): string[] {
  return Array.from(_runners.keys());
}
