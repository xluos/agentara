import type { UserMessage } from "@/shared";

import type { Card } from "../../community/feishu/messaging/types";

import { buildCommandCard } from "./cards";

/**
 * Helpers for the kernel-owned `/new` command. Extracted from `Kernel`
 * so the parsing, message rewriting, and card construction can be unit
 * tested without instantiating the full kernel graph.
 */

const NEW_COMMAND_PREFIX_WITH_SPACE = "/new ";

/**
 * Whether the given inbound text is a `/new` invocation (with or
 * without arguments).
 */
export function isNewCommand(text: string): boolean {
  return text === "/new" || text.startsWith(NEW_COMMAND_PREFIX_WITH_SPACE);
}

/**
 * Extract the prompt that follows `/new `. Returns an empty string
 * for bare `/new` or whitespace-only args — callers should surface
 * the usage card in that case.
 */
export function extractNewPrompt(text: string): string {
  if (!isNewCommand(text)) return "";
  if (text === "/new") return "";
  return text.slice(NEW_COMMAND_PREFIX_WITH_SPACE.length).trim();
}

/**
 * Rewrite an inbound user message as the first turn of a brand-new
 * session in a brand-new Feishu thread. Drops `thread_id` so the
 * subsequent `replyMessage(replyInThread:true)` creates a fresh
 * thread instead of landing inside the thread the `/new` was typed
 * from; replaces `content` with just the prompt so the agent doesn't
 * see the `/new` wrapper.
 */
export function createFreshUserMessage(
  original: UserMessage,
  prompt: string,
  sessionId: string,
): UserMessage {
  return {
    ...original,
    session_id: sessionId,
    thread_id: undefined,
    content: [{ type: "text", text: prompt }],
  };
}

export interface KernelCommandReply {
  text: string;
  card: Card;
}

export function buildNewCommandRejectionReply(): KernelCommandReply {
  const lines = [
    "❌ /new 需要在主群里使用。",
    "- 当前已在话题中，飞书话题不支持嵌套。",
    "- 请回到主群再执行 `/new <消息>`。",
  ];
  return {
    text: "❌ /new 需要在主群（非话题内）使用；当前已在话题里，无法再嵌套新建。",
    card: buildCommandCard({ title: "新会话", lines }),
  };
}

export function buildNewCommandUsageReply(): KernelCommandReply {
  const lines = [
    "用法：`/new <消息>`",
    "- 等价于在群里 @bot 开启一个新会话 + 新话题。",
    "- 斜杠后的内容会作为第一条发给 agent 的消息。",
  ];
  return {
    text: "用法：/new <消息>",
    card: buildCommandCard({ title: "新会话", lines }),
  };
}
