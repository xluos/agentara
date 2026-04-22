import { createLogger, uuid, type CardActionPayload, type Logger } from "@/shared";

import type { FeishuMessageChannel } from "../../community/feishu/messaging/message-channel";

import {
  buildPermissionCard,
  buildPermissionResultCard,
  PERMISSION_ACTION,
  type PermissionCallbackValue,
} from "./permission-card";

/**
 * Outcome returned by {@link PermissionFlow.request}. Shape mirrors
 * Claude Code's `--permission-prompt-tool` contract so the MCP bridge
 * can pass it through almost verbatim.
 */
export interface PermissionDecision {
  behavior: "allow" | "deny";
  /**
   * Required by Claude on allow: the (possibly modified) tool input to
   * actually run. We echo back the original input unchanged — we never
   * mutate tool calls on the user's behalf.
   */
  updated_input?: Record<string, unknown>;
  /** Optional deny reason shown to the model. */
  message?: string;
  decided_by: "user" | "timeout";
}

/**
 * Parameters for a single permission-request round-trip. Everything
 * here is routed into the card (for display) or the pending registry
 * (for dispatch/validation).
 */
export interface PermissionRequestParams {
  session_id: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  channel_id: string;
  chat_id: string;
  initiator_open_id: string;
  /** Optional message id to anchor the card under (keeps reply chain intact). */
  reply_to_message_id?: string;
}

/** Default auto-deny window when the initiator never clicks. */
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

interface PendingEntry {
  request_id: string;
  session_id: string;
  tool_name: string;
  initiator_open_id: string;
  channel_id: string;
  chat_id: string;
  card_message_id: string;
  created_at: number;
  // eslint-disable-next-line no-unused-vars
  resolve: (decision: PermissionDecision) => void;
  timeout: ReturnType<typeof setTimeout>;
}

/**
 * Orchestrates one interactive permission round-trip per
 * Claude-Code tool call:
 *
 * 1. `request(params)` renders an approve/deny card into the chat,
 *    stores a pending entry keyed by the outbound card's `message_id`,
 *    and returns a Promise that resolves when the user clicks or the
 *    timeout fires.
 * 2. The kernel routes `card:action` events with
 *    `value.action === "permission_decide"` to `handleDecide(payload)`,
 *    which validates the operator, resolves the pending promise, and
 *    replaces the card with a terminal result card.
 *
 * Single-writer per request: we delete the pending entry before
 * resolving, so duplicate clicks (or a timeout that races with a late
 * click) don't double-resolve the promise.
 */
export class PermissionFlow {
  private readonly _logger: Logger = createLogger("permission-flow");
  private readonly _feishuChannels: Map<string, FeishuMessageChannel>;
  private readonly _pending = new Map<string, PendingEntry>();
  private readonly _timeoutMs: number;

  /**
   * Process-lifetime shared secret used by the MCP stdio subprocess to
   * call back into the kernel's internal permission endpoint. Rotated
   * on every kernel boot; not persisted. Only reachable from localhost.
   */
  private readonly _apiToken: string = uuid();

  constructor(deps: {
    feishuChannels: Map<string, FeishuMessageChannel>;
    timeoutMs?: number;
  }) {
    this._feishuChannels = deps.feishuChannels;
    this._timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Token the MCP subprocess must send in `Authorization: Bearer …` when
   * calling the kernel's internal permission endpoint. Threaded into
   * subprocess env at spawn time; never logged.
   */
  get apiToken(): string {
    return this._apiToken;
  }

  /** Constant-time token comparison so unauthorized callers can't time us. */
  verifyToken(candidate: string | undefined | null): boolean {
    if (!candidate) return false;
    if (candidate.length !== this._apiToken.length) return false;
    let diff = 0;
    for (let i = 0; i < candidate.length; i++) {
      diff |= candidate.charCodeAt(i) ^ this._apiToken.charCodeAt(i);
    }
    return diff === 0;
  }

  /**
   * Send a permission card to the initiator's chat and await a decision.
   *
   * Rejects only when we fail to send the card at all (no channel, API
   * error) — the caller should treat that as a deny so the tool call
   * doesn't silently stall.
   */
  async request(params: PermissionRequestParams): Promise<PermissionDecision> {
    const channel = this._feishuChannels.get(params.channel_id);
    if (!channel) {
      throw new Error(
        `Permission request for unknown channel_id=${params.channel_id}`,
      );
    }
    const requestId = uuid();
    const card = buildPermissionCard({
      request_id: requestId,
      tool_name: params.tool_name,
      tool_input: params.tool_input,
      initiator_open_id: params.initiator_open_id,
    });

    const cardMessageId = await channel.sendRawCard(params.chat_id, card, {
      replyTo: params.reply_to_message_id,
      // Keep the card inline with the original turn; threading would hide
      // it from anyone not already following the topic.
      replyInThread: false,
    });

    return new Promise<PermissionDecision>((resolve) => {
      const timeout = setTimeout(() => {
        const entry = this._pending.get(cardMessageId);
        if (!entry) return;
        this._pending.delete(cardMessageId);
        this._logger.warn(
          {
            request_id: requestId,
            session_id: params.session_id,
            tool_name: params.tool_name,
          },
          "permission request timed out, auto-denying",
        );
        void this._tryUpdateCard(
          params.channel_id,
          cardMessageId,
          buildPermissionResultCard({
            tool_name: params.tool_name,
            outcome: "timeout",
          }),
          "timeout",
        );
        resolve({
          behavior: "deny",
          message: "Permission request timed out after 5 minutes.",
          decided_by: "timeout",
        });
      }, this._timeoutMs);

      this._pending.set(cardMessageId, {
        request_id: requestId,
        session_id: params.session_id,
        tool_name: params.tool_name,
        initiator_open_id: params.initiator_open_id,
        channel_id: params.channel_id,
        chat_id: params.chat_id,
        card_message_id: cardMessageId,
        created_at: Date.now(),
        resolve,
        timeout,
      });
      this._logger.info(
        {
          request_id: requestId,
          session_id: params.session_id,
          tool_name: params.tool_name,
          card_message_id: cardMessageId,
        },
        "permission card sent",
      );
    });
  }

  /**
   * Entry point invoked from the kernel's `card:action` listener when the
   * payload's `value.action === PERMISSION_ACTION`. Looks up the pending
   * entry, validates the operator, and either resolves the Promise with
   * the clicked decision or surfaces an error card.
   */
  async handleDecide(payload: CardActionPayload): Promise<void> {
    const channel = this._feishuChannels.get(payload.channel_id);
    if (!channel) {
      this._logger.warn(
        { channel_id: payload.channel_id },
        "permission action for unknown channel",
      );
      return;
    }
    const entry = this._pending.get(payload.message_id);
    if (!entry) {
      await this._tryUpdateCard(
        payload.channel_id,
        payload.message_id,
        buildPermissionResultCard({
          tool_name: "(unknown)",
          outcome: "already_decided",
        }),
        "already-decided",
      );
      return;
    }
    if (entry.initiator_open_id !== payload.operator_open_id) {
      // Don't consume the pending entry — the initiator can still click.
      // We don't mutate the card either: rewriting buttons on the fly
      // races with the pending promise and risks losing them on failure.
      // The clicker sees Feishu's generic ack toast; the card stays
      // intact for the initiator to act on.
      this._logger.info(
        {
          request_id: entry.request_id,
          operator: payload.operator_open_id,
          initiator: entry.initiator_open_id,
        },
        "non-initiator click on permission card; ignoring",
      );
      return;
    }

    const value = payload.value as unknown as PermissionCallbackValue;
    const decision: "allow" | "deny" =
      value?.decision === "allow" ? "allow" : "deny";

    this._pending.delete(payload.message_id);
    clearTimeout(entry.timeout);

    await this._tryUpdateCard(
      payload.channel_id,
      payload.message_id,
      buildPermissionResultCard({
        tool_name: entry.tool_name,
        outcome: decision === "allow" ? "allowed" : "denied",
        decided_by_open_id: payload.operator_open_id,
      }),
      "final-result",
    );

    this._logger.info(
      {
        request_id: entry.request_id,
        session_id: entry.session_id,
        tool_name: entry.tool_name,
        decision,
      },
      "permission request decided",
    );

    entry.resolve({
      behavior: decision,
      message:
        decision === "deny" ? "Permission denied by the user." : undefined,
      decided_by: "user",
    });
  }

  /**
   * Tag for the {@link PermissionFlow._handleCardAction} discriminator —
   * exported so the kernel-level router can filter by `value.action`
   * without re-deriving the string constant.
   */
  static readonly ACTION_NAME = PERMISSION_ACTION;

  private async _tryUpdateCard(
    channelId: string,
    messageId: string,
    card: ReturnType<typeof buildPermissionResultCard>,
    stage: string,
  ): Promise<void> {
    const channel = this._feishuChannels.get(channelId);
    if (!channel) return;
    try {
      await channel.updateRawCard(messageId, card);
    } catch (err) {
      this._logger.error(
        { err, stage, message_id: messageId },
        "permission updateRawCard failed",
      );
    }
  }
}
