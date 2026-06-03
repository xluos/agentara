import { buildCommandCard } from "./cards";
import type { KernelCommandReply } from "./new-command";
import { parseCommand } from "./parser";

/**
 * Build the "unknown command" reply for `/`-prefixed messages that
 * don't map to any registered handler. Kernel uses this as the
 * fallback so unrecognized slashes fail loudly instead of being
 * forwarded to the agent.
 */
export function buildUnknownCommandReply(text: string): KernelCommandReply {
  const parsed = parseCommand(text);
  const lines = parsed
    ? [
        `❌ \`/${parsed.name}\` 不是已注册的命令。`,
        "- 使用 `/help` 查看所有可用命令。",
      ]
    : [
        "❌ 命令格式不正确（斜杠后需要跟命令名）。",
        "- 使用 `/help` 查看所有可用命令。",
      ];
  return {
    text: lines.join("\n"),
    card: buildCommandCard({ title: "未知命令", lines }),
  };
}
