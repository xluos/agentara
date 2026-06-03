import { existsSync, readFileSync } from "node:fs";

import { AssistantMessage, config, type MessageUsage } from "@/shared";

export interface SessionUsageSnapshot {
  message_id: string;
  used_tokens: number;
  model?: string;
}

export function readLatestSessionUsageSnapshot(
  sessionId: string,
  path = config.paths.resolveSessionFilePath(sessionId),
): SessionUsageSnapshot | undefined {
  if (!existsSync(path)) return undefined;
  const lines = readFileSync(path, "utf-8").trimEnd().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const message = AssistantMessage.safeParse(parsed);
    if (!message.success || !message.data.usage) continue;
    const usedTokens = countUsageTokens(message.data.usage);
    if (usedTokens <= 0) continue;
    return {
      message_id: message.data.id,
      used_tokens: usedTokens,
      model: message.data.model,
    };
  }
  return undefined;
}

export function countUsageTokens(usage: MessageUsage): number {
  return (
    (usage.input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.output_tokens ?? 0)
  );
}
