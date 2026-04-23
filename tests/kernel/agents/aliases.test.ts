import { describe, expect, test } from "bun:test";

import {
  isLegacyAgentTypeAlias,
  resolveAgentTypeAlias,
} from "@/kernel/agents";

describe("agent type aliases", () => {
  test("maps removed codex-gated sessions to codex-yolo", () => {
    expect(resolveAgentTypeAlias("codex-gated")).toBe("codex-yolo");
    expect(isLegacyAgentTypeAlias("codex-gated")).toBe(true);
  });

  test("leaves current runner types unchanged", () => {
    expect(resolveAgentTypeAlias("codex-yolo")).toBe("codex-yolo");
    expect(resolveAgentTypeAlias("codex")).toBe("codex");
    expect(isLegacyAgentTypeAlias("codex-yolo")).toBe(false);
  });
});
