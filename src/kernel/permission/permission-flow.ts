import { createLogger, uuid, type CardActionPayload, type Logger } from "@/shared";

import type { FeishuMessageChannel } from "../../community/feishu/messaging/message-channel";

import {
  AskUserQuestionInput,
  buildPermissionCard,
  buildPermissionResultCard,
  buildQuestionCard,
  buildQuestionResultCard,
  PERMISSION_ACTION,
  QUESTION_FIELD,
  type AskUserQuestionItem,
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
  tool_use_id?: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  channel_id: string;
  chat_id: string;
  initiator_open_id: string;
  /** Optional message id to anchor the card under (keeps reply chain intact). */
  reply_to_message_id?: string;
}

/** Default auto-deny window when the initiator never clicks. */
const DEFAULT_TIMEOUT_MINUTES = 30;
const DEFAULT_TIMEOUT_MS = DEFAULT_TIMEOUT_MINUTES * 60 * 1000;

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
 * Pending state for one `AskUserQuestion` round-trip. Keyed by the card's
 * `message_id` like {@link PendingEntry}, but carries the parsed questions so
 * the submit handler can map `form_value` back to option labels.
 */
interface PendingQuestionEntry {
  request_id: string;
  session_id: string;
  initiator_open_id: string;
  channel_id: string;
  chat_id: string;
  card_message_id: string;
  tool_use_id?: string;
  questions: AskUserQuestionItem[];
  created_at: number;
  // eslint-disable-next-line no-unused-vars
  resolve: (decision: PermissionDecision) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export interface QuestionStatusEvent {
  session_id: string;
  tool_use_id?: string;
  status: "waiting" | "answered" | "timeout" | "expired";
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
  private readonly _onQuestionStatus?: (
    // eslint-disable-next-line no-unused-vars
    event: QuestionStatusEvent,
  ) => void | Promise<void>;
  private readonly _pending = new Map<string, PendingEntry>();
  private readonly _pendingQuestions = new Map<string, PendingQuestionEntry>();
  private readonly _timeoutMs: number;
  /**
   * Per-session allow list populated when the user picks "allow this tool
   * for the whole session" on a permission card. Keyed by `session_id`;
   * each value is the set of tool names approved for that session. In-memory
   * only — a kernel restart drops the list so trust never survives across
   * boots.
   */
  private readonly _sessionAllowlist = new Map<string, Set<string>>();

  /**
   * Process-lifetime shared secret used by the MCP stdio subprocess to
   * call back into the kernel's internal permission endpoint. Rotated
   * on every kernel boot; not persisted. Only reachable from localhost.
   */
  private readonly _apiToken: string = uuid();

  constructor(deps: {
    feishuChannels: Map<string, FeishuMessageChannel>;
    timeoutMs?: number;
    onQuestionStatus?: (
      // eslint-disable-next-line no-unused-vars
      event: QuestionStatusEvent,
    ) => void | Promise<void>;
  }) {
    this._feishuChannels = deps.feishuChannels;
    this._timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this._onQuestionStatus = deps.onQuestionStatus;
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
    // AskUserQuestion needs answers, not approve/deny — route it to the
    // dedicated question form before the approval machinery below.
    if (params.tool_name === "AskUserQuestion") {
      return this._requestQuestion(params);
    }
    const channel = this._feishuChannels.get(params.channel_id);
    if (!channel) {
      throw new Error(
        `Permission request for unknown channel_id=${params.channel_id}`,
      );
    }
    // Session-wide allow short-circuit: if the user has already opted to
    // trust this tool for the whole session, skip the card and auto-approve.
    if (this._isSessionAllowed(params.session_id, params.tool_name)) {
      this._logger.info(
        { session_id: params.session_id, tool_name: params.tool_name },
        "permission auto-allowed from session allowlist",
      );
      return {
        behavior: "allow",
        updated_input: params.tool_input,
        decided_by: "user",
      };
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
      const timeout = setTimeout(async () => {
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
        await this._tryUpdateCard(
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
          message: `Permission request timed out after ${DEFAULT_TIMEOUT_MINUTES} minutes.`,
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
    const rawDecision = value?.decision;
    const decision: "allow" | "deny" | "allow_session" =
      rawDecision === "allow" || rawDecision === "allow_session"
        ? rawDecision
        : "deny";

    this._pending.delete(payload.message_id);
    clearTimeout(entry.timeout);

    if (decision === "allow_session") {
      this._rememberSessionAllow(entry.session_id, entry.tool_name);
    }

    const outcome =
      decision === "allow"
        ? "allowed"
        : decision === "allow_session"
          ? "allowed_session"
          : "denied";
    await this._tryUpdateCard(
      payload.channel_id,
      payload.message_id,
      buildPermissionResultCard({
        tool_name: entry.tool_name,
        outcome,
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
      behavior: decision === "deny" ? "deny" : "allow",
      message:
        decision === "deny" ? "Permission denied by the user." : undefined,
      decided_by: "user",
    });
  }

  /**
   * Send an AskUserQuestion form to the initiator's chat and await the
   * answers. On a malformed payload we deny with a hint so the tool call
   * resolves instead of hanging; otherwise we store a pending entry keyed by
   * the card's `message_id` and resolve when the user submits or the timeout
   * fires.
   */
  private async _requestQuestion(
    params: PermissionRequestParams,
  ): Promise<PermissionDecision> {
    const channel = this._feishuChannels.get(params.channel_id);
    if (!channel) {
      throw new Error(
        `Question request for unknown channel_id=${params.channel_id}`,
      );
    }
    const parsed = AskUserQuestionInput.safeParse(params.tool_input);
    if (!parsed.success) {
      this._logger.warn(
        { session_id: params.session_id, issues: parsed.error.issues },
        "malformed AskUserQuestion input, denying",
      );
      return {
        behavior: "deny",
        message:
          "AskUserQuestion payload was malformed. Ask the user in plain text instead.",
        decided_by: "user",
      };
    }
    const questions = parsed.data.questions;
    const requestId = uuid();
    const card = buildQuestionCard({
      request_id: requestId,
      questions,
      initiator_open_id: params.initiator_open_id,
    });
    const cardMessageId = await channel.sendRawCard(params.chat_id, card, {
      replyTo: params.reply_to_message_id,
      replyInThread: false,
    });

    return new Promise<PermissionDecision>((resolve) => {
      const timeout = setTimeout(async () => {
        const entry = this._pendingQuestions.get(cardMessageId);
        if (!entry) return;
        this._pendingQuestions.delete(cardMessageId);
        this._logger.warn(
          { request_id: requestId, session_id: params.session_id },
          "question request timed out, auto-denying",
        );
        await this._tryUpdateCard(
          params.channel_id,
          cardMessageId,
          buildQuestionResultCard({ outcome: "timeout" }),
          "question-timeout",
        );
        void this._emitQuestionStatus({
          session_id: params.session_id,
          tool_use_id: params.tool_use_id,
          status: "timeout",
        });
        resolve({
          behavior: "deny",
          message: `Question timed out after ${DEFAULT_TIMEOUT_MINUTES} minutes with no answer.`,
          decided_by: "timeout",
        });
      }, this._timeoutMs);

      this._pendingQuestions.set(cardMessageId, {
        request_id: requestId,
        session_id: params.session_id,
        tool_use_id: params.tool_use_id,
        initiator_open_id: params.initiator_open_id,
        channel_id: params.channel_id,
        chat_id: params.chat_id,
        card_message_id: cardMessageId,
        questions,
        created_at: Date.now(),
        resolve,
        timeout,
      });
      this._logger.info(
        {
          request_id: requestId,
          session_id: params.session_id,
          card_message_id: cardMessageId,
          question_count: questions.length,
        },
        "question card sent",
      );
      void this._emitQuestionStatus({
        session_id: params.session_id,
        tool_use_id: params.tool_use_id,
        status: "waiting",
      });
    });
  }

  /**
   * Entry point invoked from the kernel's `card:action` listener when the
   * payload's `action_name === QUESTION_ACTION` (the form's submit button).
   * Maps `form_value` back to option labels; an incomplete submission
   * re-renders the form with a warning instead of resolving.
   */
  async handleQuestionSubmit(payload: CardActionPayload): Promise<void> {
    const channel = this._feishuChannels.get(payload.channel_id);
    if (!channel) {
      this._logger.warn(
        { channel_id: payload.channel_id },
        "question action for unknown channel",
      );
      return;
    }
    const entry = this._pendingQuestions.get(payload.message_id);
    if (!entry) {
      await this._tryUpdateCard(
        payload.channel_id,
        payload.message_id,
        buildQuestionResultCard({ outcome: "already_answered" }),
        "question-already-answered",
      );
      return;
    }
    if (entry.initiator_open_id !== payload.operator_open_id) {
      // Keep the form intact for the initiator; the clicker just sees the
      // generic Feishu ack. Mirrors the approve/deny card's behavior.
      this._logger.info(
        {
          request_id: entry.request_id,
          operator: payload.operator_open_id,
          initiator: entry.initiator_open_id,
        },
        "non-initiator submit on question card; ignoring",
      );
      return;
    }

    const answers: Record<string, string | string[]> = {};
    const detail: string[] = [];
    const missing: string[] = [];
    entry.questions.forEach((q, qi) => {
      const heading = q.header?.trim() ? q.header.trim() : `问题 ${qi + 1}`;
      if (q.multiSelect) {
        const picked = q.options
          .filter((_opt, oi) =>
            _isTruthyChecker(payload.form_value[QUESTION_FIELD.checker(qi, oi)]),
          )
          .map((opt) => opt.label);
        if (picked.length === 0) {
          missing.push(heading);
        } else {
          answers[q.question] = picked;
          detail.push(`- ${heading}：${picked.join("、")}`);
        }
      } else {
        const raw = payload.form_value[QUESTION_FIELD.select(qi)];
        const oi = typeof raw === "string" ? Number(raw) : Number.NaN;
        const picked = Number.isInteger(oi) ? q.options[oi] : undefined;
        if (picked) {
          answers[q.question] = picked.label;
          detail.push(`- ${heading}：${picked.label}`);
        } else {
          missing.push(heading);
        }
      }
    });

    if (missing.length > 0) {
      // Re-render the form (selections reset client-side) with a warning;
      // keep the pending entry and timeout alive for the retry.
      await this._tryUpdateCard(
        entry.channel_id,
        entry.card_message_id,
        buildQuestionCard({
          request_id: entry.request_id,
          questions: entry.questions,
          initiator_open_id: entry.initiator_open_id,
          warning: `请回答所有问题后再提交（待回答：${missing.join("、")}）`,
        }),
        "question-incomplete",
      );
      return;
    }

    this._pendingQuestions.delete(payload.message_id);
    clearTimeout(entry.timeout);
    await this._tryUpdateCard(
      payload.channel_id,
      payload.message_id,
      buildQuestionResultCard({ outcome: "answered", detail }),
      "question-answered",
    );
    await this._emitQuestionStatus({
      session_id: entry.session_id,
      tool_use_id: entry.tool_use_id,
      status: "answered",
    });
    this._logger.info(
      { request_id: entry.request_id, session_id: entry.session_id },
      "question answered",
    );
    entry.resolve({
      behavior: "allow",
      updated_input: { questions: entry.questions, answers },
      decided_by: "user",
    });
  }

  /**
   * Mark every still-open permission and question card as expired and resolve
   * its awaiting promise with a deny. Called on kernel shutdown: the agent
   * subprocesses that long-poll for these decisions die with the kernel, so a
   * card left untouched would look live yet never resolve. Best-effort — a
   * failed card update is logged, not retried.
   */
  async expireAllPending(): Promise<void> {
    const permissionEntries = [...this._pending.values()];
    const questionEntries = [...this._pendingQuestions.values()];
    this._pending.clear();
    this._pendingQuestions.clear();

    for (const entry of permissionEntries) {
      clearTimeout(entry.timeout);
      await this._tryUpdateCard(
        entry.channel_id,
        entry.card_message_id,
        buildPermissionResultCard({
          tool_name: entry.tool_name,
          outcome: "expired",
        }),
        "shutdown-expire",
      );
      entry.resolve({
        behavior: "deny",
        message: "Kernel is shutting down; permission request expired.",
        decided_by: "timeout",
      });
    }
    for (const entry of questionEntries) {
      clearTimeout(entry.timeout);
      await this._tryUpdateCard(
        entry.channel_id,
        entry.card_message_id,
        buildQuestionResultCard({ outcome: "expired" }),
        "shutdown-expire",
      );
      void this._emitQuestionStatus({
        session_id: entry.session_id,
        tool_use_id: entry.tool_use_id,
        status: "expired",
      });
      entry.resolve({
        behavior: "deny",
        message: "Kernel is shutting down; question expired.",
        decided_by: "timeout",
      });
    }
    if (permissionEntries.length > 0 || questionEntries.length > 0) {
      this._logger.info(
        {
          permission_cards: permissionEntries.length,
          question_cards: questionEntries.length,
        },
        "expired open permission/question cards on shutdown",
      );
    }
  }

  /**
   * Forget every tool remembered for the given session. Call on session
   * teardown if you want to release memory eagerly; otherwise the map is
   * cleared on the next kernel restart.
   */
  clearSession(sessionId: string): void {
    this._sessionAllowlist.delete(sessionId);
  }

  private _isSessionAllowed(sessionId: string, toolName: string): boolean {
    return this._sessionAllowlist.get(sessionId)?.has(toolName) === true;
  }

  private _rememberSessionAllow(sessionId: string, toolName: string): void {
    let set = this._sessionAllowlist.get(sessionId);
    if (!set) {
      set = new Set();
      this._sessionAllowlist.set(sessionId, set);
    }
    set.add(toolName);
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

  private async _emitQuestionStatus(event: QuestionStatusEvent): Promise<void> {
    if (!this._onQuestionStatus) return;
    try {
      await this._onQuestionStatus(event);
    } catch (err) {
      this._logger.warn(
        { err, session_id: event.session_id, tool_use_id: event.tool_use_id },
        "question status callback failed",
      );
    }
  }
}

/**
 * Coerce a Feishu checker's echoed `form_value` entry to a boolean. Some
 * clients send the literal boolean, others a string like `"true"`/`"on"`.
 */
function _isTruthyChecker(v: unknown): boolean {
  if (v === true) return true;
  if (typeof v === "string") {
    const lower = v.toLowerCase();
    return lower === "true" || lower === "1" || lower === "on";
  }
  return false;
}
