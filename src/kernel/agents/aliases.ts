const LEGACY_AGENT_TYPE_ALIASES: Record<string, string> = {
  "codex-gated": "codex-yolo",
};

export function resolveAgentTypeAlias(type: string): string {
  return LEGACY_AGENT_TYPE_ALIASES[type] ?? type;
}

export function isLegacyAgentTypeAlias(type: string): boolean {
  return LEGACY_AGENT_TYPE_ALIASES[type] !== undefined;
}
