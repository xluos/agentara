import { ClaudeAgentRunner } from "@/community/anthropic";
import { CodexAgentRunner } from "@/community/openai";
import { DummyAgentRunner, MockAgentRunner, type AgentRunner } from "@/shared";

import { createRunner, registerRunner } from "./registry";

// Register the built-in runners at module load. Plugins under `src/plugins`
// are imported separately (see `src/plugins/index.ts`) and register
// themselves by the same mechanism.
registerRunner("claude", () => new ClaudeAgentRunner());
registerRunner("codex", () => new CodexAgentRunner());
registerRunner("dummy", () => new DummyAgentRunner());
registerRunner(
  "mock",
  () =>
    new MockAgentRunner(
      "user-home/sessions/34681283-bf20-4dc4-8301-a0929104002e.jsonl",
    ),
);

/**
 * Creates an agent runner based on the agent type. Thin wrapper over the
 * registry for back-compat with existing call sites.
 */
export function createAgentRunner(agentType: string): AgentRunner {
  return createRunner(agentType);
}
