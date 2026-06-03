import { Client } from "@larksuiteoapi/node-sdk";

import { config, createLogger, reloadConfig } from "@/shared";

import type { Card } from "./messaging/types";

const _logger = createLogger("feishu-crash-notifier");

/**
 * Describes which crash event the supervisor wants to surface to the operator.
 *
 * - `restart`: the server crashed and was relaunched; `attempt`/`max` tell the
 *   operator how much of the restart budget is left.
 * - `giveup`: the server crashed too many times in a row; auto-restart has
 *   stopped and a human needs to step in.
 */
export interface CrashNotice {
  kind: "restart" | "giveup";
  attempt: number;
  max: number;
}

/**
 * Resolve the Feishu channel the supervisor should notify. Prefers the
 * configured `default_channel_id`; otherwise falls back to the first Feishu
 * channel that carries usable credentials. Returns undefined when no channel
 * is usable so the caller can degrade to a log-only path.
 */
function _resolveTarget():
  | { appId: string; appSecret: string; chatId: string }
  | undefined {
  const channels = config.messaging.channels.filter(
    (c) =>
      c.type === "feishu" &&
      c.params.app_id &&
      c.params.app_secret &&
      c.params.chat_id,
  );
  if (channels.length === 0) {
    return undefined;
  }
  const preferred =
    channels.find((c) => c.id === config.messaging.default_channel_id) ??
    channels[0]!;
  return {
    appId: preferred.params.app_id!,
    appSecret: preferred.params.app_secret!,
    chatId: preferred.params.chat_id!,
  };
}

/**
 * Build the notification card. Intentionally content-light: the operator asked
 * only to know that the server errored, not to see stack traces here. The
 * header color encodes severity (orange = recovered, red = gave up).
 */
function _buildCard(notice: CrashNotice): Card {
  const isGiveup = notice.kind === "giveup";
  const title = isGiveup
    ? "❌ Agentara 服务端持续报错"
    : "⚠️ Agentara 服务端报错";
  const text = isGiveup
    ? `服务端连续崩溃，已自动重启 ${notice.max} 次仍未恢复，已停止自动重启，请人工检查。`
    : `服务端检测到异常并已自动重启（第 ${notice.attempt}/${notice.max} 次）。`;
  return {
    schema: "2.0",
    config: { streaming_mode: false, summary: { content: title } },
    head: {
      title: { tag: "plain_text", content: title },
      template: isGiveup ? "red" : "orange",
    },
    body: {
      elements: [{ tag: "markdown", content: text }],
    },
  };
}

/**
 * Best-effort crash notification sent by the supervisor. Reloads config from
 * disk first because the supervisor starts before the child boot-loader writes
 * `config.yaml`, so its initial in-memory config may be empty. Never throws:
 * the supervisor must keep managing the process even if Feishu is unreachable.
 */
export async function notifyServerCrash(notice: CrashNotice): Promise<void> {
  try {
    reloadConfig();
    const target = _resolveTarget();
    if (!target) {
      _logger.warn("no usable Feishu channel; skipping crash notification");
      return;
    }
    const client = new Client({
      appId: target.appId,
      appSecret: target.appSecret,
    });
    await client.im.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: target.chatId,
        msg_type: "interactive",
        content: JSON.stringify(_buildCard(notice)),
      },
    });
    _logger.info({ kind: notice.kind }, "crash notification sent");
  } catch (err) {
    _logger.error({ err }, "failed to send crash notification");
  }
}
