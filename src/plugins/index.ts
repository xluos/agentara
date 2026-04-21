/**
 * Plugin barrel — importing this module side-effects registers every
 * plugin under `src/plugins/*` with the agent runner registry. Add new
 * plugins by creating a module that calls `registerRunner(...)` at
 * top-level and appending it to this barrel.
 *
 * The kernel imports this once at startup (see `kernel.ts`), so by the
 * time the first session dispatches, every plugin runner is resolvable
 * via `agents.default.type` in config.yaml.
 */
import "./claude-gated";
import "./codex-gated";
