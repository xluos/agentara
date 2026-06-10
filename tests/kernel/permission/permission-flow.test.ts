import { describe, expect, test } from "bun:test";


import type { FeishuMessageChannel } from "@/community/feishu/messaging/message-channel";
import type { Card } from "@/community/feishu/messaging/types";
import { PermissionFlow } from "@/kernel/permission";
import type { CardActionPayload } from "@/shared";

interface FakeChannel {
  sentCards: Array<{ chatId: string; card: Card }>;
  updatedCards: Array<{ messageId: string; card: Card }>;
}

function _makeChannel(messageId: string): {
  fake: FakeChannel;
  channel: FeishuMessageChannel;
} {
  const fake: FakeChannel = { sentCards: [], updatedCards: [] };
  const channel = {
    async sendRawCard(chatId: string, card: Card) {
      fake.sentCards.push({ chatId, card });
      return messageId;
    },
    async updateRawCard(mid: string, card: Card) {
      fake.updatedCards.push({ messageId: mid, card });
    },
  } as unknown as FeishuMessageChannel;
  return { fake, channel };
}

function _makePayload(overrides: Partial<CardActionPayload>): CardActionPayload {
  return {
    message_id: overrides.message_id ?? "card_msg_1",
    channel_id: overrides.channel_id ?? "ch_1",
    chat_id: overrides.chat_id ?? "oc_chat",
    operator_open_id: overrides.operator_open_id ?? "ou_alice",
    action_name: overrides.action_name ?? "permission_decide",
    value: overrides.value ?? {},
    form_value: overrides.form_value ?? {},
  };
}

describe("PermissionFlow", () => {
  test("resolves 'allow' when the initiator clicks Approve", async () => {
    const { channel } = _makeChannel("card_msg_1");
    const flow = new PermissionFlow({
      feishuChannels: new Map([["ch_1", channel]]),
    });
    const promise = flow.request({
      session_id: "s1",
      channel_id: "ch_1",
      chat_id: "oc_chat",
      initiator_open_id: "ou_alice",
      tool_name: "Bash",
      tool_input: { command: "ls" },
    });
    // Let the send-card await resolve before we fire the click.
    await Promise.resolve();
    await flow.handleDecide(
      _makePayload({
        message_id: "card_msg_1",
        operator_open_id: "ou_alice",
        value: {
          action: "permission_decide",
          request_id: "whatever",
          decision: "allow",
        },
      }),
    );
    const decision = await promise;
    expect(decision.behavior).toBe("allow");
    expect(decision.decided_by).toBe("user");
  });

  test("ignores non-initiator clicks; initiator can still decide", async () => {
    const { channel } = _makeChannel("card_msg_2");
    const flow = new PermissionFlow({
      feishuChannels: new Map([["ch_1", channel]]),
    });
    const promise = flow.request({
      session_id: "s1",
      channel_id: "ch_1",
      chat_id: "oc_chat",
      initiator_open_id: "ou_alice",
      tool_name: "Bash",
      tool_input: {},
    });
    await Promise.resolve();

    await flow.handleDecide(
      _makePayload({
        message_id: "card_msg_2",
        operator_open_id: "ou_mallory",
        value: {
          action: "permission_decide",
          request_id: "x",
          decision: "allow",
        },
      }),
    );
    // Pending must still resolve on the real initiator's click.
    await flow.handleDecide(
      _makePayload({
        message_id: "card_msg_2",
        operator_open_id: "ou_alice",
        value: {
          action: "permission_decide",
          request_id: "x",
          decision: "deny",
        },
      }),
    );
    const decision = await promise;
    expect(decision.behavior).toBe("deny");
    expect(decision.decided_by).toBe("user");
  });

  test("auto-denies after the timeout fires", async () => {
    const { channel } = _makeChannel("card_msg_3");
    const flow = new PermissionFlow({
      feishuChannels: new Map([["ch_1", channel]]),
      timeoutMs: 30,
    });
    const decision = await flow.request({
      session_id: "s1",
      channel_id: "ch_1",
      chat_id: "oc_chat",
      initiator_open_id: "ou_alice",
      tool_name: "Bash",
      tool_input: {},
    });
    expect(decision.behavior).toBe("deny");
    expect(decision.decided_by).toBe("timeout");
  });

  test("allow_session remembers the tool and skips the card next time", async () => {
    const { fake, channel } = _makeChannel("card_msg_session_1");
    const flow = new PermissionFlow({
      feishuChannels: new Map([["ch_1", channel]]),
    });

    // First call prompts; user picks "allow for this session".
    const first = flow.request({
      session_id: "s-session",
      channel_id: "ch_1",
      chat_id: "oc_chat",
      initiator_open_id: "ou_alice",
      tool_name: "Bash",
      tool_input: { command: "ls" },
    });
    await Promise.resolve();
    await flow.handleDecide(
      _makePayload({
        message_id: "card_msg_session_1",
        operator_open_id: "ou_alice",
        value: {
          action: "permission_decide",
          request_id: "r1",
          decision: "allow_session",
        },
      }),
    );
    const firstDecision = await first;
    expect(firstDecision.behavior).toBe("allow");

    // A second call for the same tool on the same session must resolve
    // immediately with `allow` and NOT touch the channel at all.
    const cardsBefore = fake.sentCards.length;
    const second = await flow.request({
      session_id: "s-session",
      channel_id: "ch_1",
      chat_id: "oc_chat",
      initiator_open_id: "ou_alice",
      tool_name: "Bash",
      tool_input: { command: "pwd" },
    });
    expect(second.behavior).toBe("allow");
    expect(second.decided_by).toBe("user");
    expect(fake.sentCards.length).toBe(cardsBefore);

    // Different tool still prompts — allowlist is per-tool.
    const third = flow.request({
      session_id: "s-session",
      channel_id: "ch_1",
      chat_id: "oc_chat",
      initiator_open_id: "ou_alice",
      tool_name: "Edit",
      tool_input: {},
    });
    await Promise.resolve();
    expect(fake.sentCards.length).toBe(cardsBefore + 1);
    // Clean up the dangling request so the test exits promptly.
    flow.clearSession("s-session");
    void third.catch(() => {});
  });

  test("clearSession forgets previously allowed tools", async () => {
    const { fake, channel } = _makeChannel("card_msg_clear_1");
    const flow = new PermissionFlow({
      feishuChannels: new Map([["ch_1", channel]]),
    });
    const first = flow.request({
      session_id: "s-clear",
      channel_id: "ch_1",
      chat_id: "oc_chat",
      initiator_open_id: "ou_alice",
      tool_name: "Bash",
      tool_input: {},
    });
    await Promise.resolve();
    await flow.handleDecide(
      _makePayload({
        message_id: "card_msg_clear_1",
        operator_open_id: "ou_alice",
        value: {
          action: "permission_decide",
          request_id: "r2",
          decision: "allow_session",
        },
      }),
    );
    await first;

    flow.clearSession("s-clear");

    // After clearing, the next call must prompt again (card sent).
    const cardsBefore = fake.sentCards.length;
    const next = flow.request({
      session_id: "s-clear",
      channel_id: "ch_1",
      chat_id: "oc_chat",
      initiator_open_id: "ou_alice",
      tool_name: "Bash",
      tool_input: {},
    });
    await Promise.resolve();
    expect(fake.sentCards.length).toBe(cardsBefore + 1);
    void next.catch(() => {});
  });

  test("AskUserQuestion resolves 'allow' with answers on submit", async () => {
    const { fake, channel } = _makeChannel("card_q_1");
    const statuses: Array<{ status: string; tool_use_id?: string }> = [];
    const flow = new PermissionFlow({
      feishuChannels: new Map([["ch_1", channel]]),
      onQuestionStatus: (event) => {
        statuses.push(event);
      },
    });
    const promise = flow.request({
      session_id: "sq",
      tool_use_id: "toolu_question_1",
      channel_id: "ch_1",
      chat_id: "oc_chat",
      initiator_open_id: "ou_alice",
      tool_name: "AskUserQuestion",
      tool_input: {
        questions: [
          {
            question: "Pick a format",
            header: "Format",
            options: [
              { label: "Summary", description: "short" },
              { label: "Detailed", description: "long" },
            ],
            multiSelect: false,
          },
          {
            question: "Pick sections",
            header: "Sections",
            options: [
              { label: "Intro", description: "" },
              { label: "Outro", description: "" },
            ],
            multiSelect: true,
          },
        ],
      },
    });
    await Promise.resolve();
    expect(fake.sentCards.length).toBe(1);
    expect(statuses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "waiting",
          tool_use_id: "toolu_question_1",
        }),
      ]),
    );

    await flow.handleQuestionSubmit(
      _makePayload({
        message_id: "card_q_1",
        operator_open_id: "ou_alice",
        action_name: "permission_question_submit",
        // q0 -> option index 1 (Detailed); q1 -> Intro + Outro checked
        form_value: { q0: "1", q1_o0: true, q1_o1: "true" },
      }),
    );

    const decision = await promise;
    expect(decision.behavior).toBe("allow");
    expect(decision.decided_by).toBe("user");
    expect(statuses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "answered",
          tool_use_id: "toolu_question_1",
        }),
      ]),
    );
    const input = decision.updated_input as {
      questions: unknown[];
      answers: Record<string, unknown>;
    };
    expect(input.questions).toHaveLength(2);
    expect(input.answers["Pick a format"]).toBe("Detailed");
    expect(input.answers["Pick sections"]).toEqual(["Intro", "Outro"]);
  });

  test("AskUserQuestion re-renders (no resolve) when a question is unanswered", async () => {
    const { fake, channel } = _makeChannel("card_q_2");
    const flow = new PermissionFlow({
      feishuChannels: new Map([["ch_1", channel]]),
    });
    let settled = false;
    const promise = flow
      .request({
        session_id: "sq2",
        channel_id: "ch_1",
        chat_id: "oc_chat",
        initiator_open_id: "ou_alice",
        tool_name: "AskUserQuestion",
        tool_input: {
          questions: [
            {
              question: "Pick one",
              options: [{ label: "A" }, { label: "B" }],
            },
          ],
        },
      })
      .then((d) => {
        settled = true;
        return d;
      });
    await Promise.resolve();

    // Submit with nothing selected -> card updated with a warning, unresolved.
    await flow.handleQuestionSubmit(
      _makePayload({
        message_id: "card_q_2",
        operator_open_id: "ou_alice",
        action_name: "permission_question_submit",
        form_value: {},
      }),
    );
    expect(fake.updatedCards.length).toBe(1);
    expect(settled).toBe(false);

    // Now answer it for real -> resolves allow.
    await flow.handleQuestionSubmit(
      _makePayload({
        message_id: "card_q_2",
        operator_open_id: "ou_alice",
        action_name: "permission_question_submit",
        form_value: { q0: "0" },
      }),
    );
    const decision = await promise;
    expect(decision.behavior).toBe("allow");
    expect(
      (decision.updated_input as { answers: Record<string, unknown> }).answers[
        "Pick one"
      ],
    ).toBe("A");
  });

  test("AskUserQuestion denies a malformed payload instead of hanging", async () => {
    const { fake, channel } = _makeChannel("card_q_3");
    const flow = new PermissionFlow({
      feishuChannels: new Map([["ch_1", channel]]),
    });
    const decision = await flow.request({
      session_id: "sq3",
      channel_id: "ch_1",
      chat_id: "oc_chat",
      initiator_open_id: "ou_alice",
      tool_name: "AskUserQuestion",
      tool_input: { questions: [] },
    });
    expect(decision.behavior).toBe("deny");
    expect(fake.sentCards.length).toBe(0);
  });

  test("expireAllPending denies open cards and marks them expired", async () => {
    const { fake, channel } = _makeChannel("card_exp_1");
    const flow = new PermissionFlow({
      feishuChannels: new Map([["ch_1", channel]]),
    });
    // One open approval card.
    const approval = flow.request({
      session_id: "se",
      channel_id: "ch_1",
      chat_id: "oc_chat",
      initiator_open_id: "ou_alice",
      tool_name: "Bash",
      tool_input: {},
    });
    await Promise.resolve();

    await flow.expireAllPending();

    const decision = await approval;
    expect(decision.behavior).toBe("deny");
    // The card was updated in place to a terminal (expired) result.
    expect(fake.updatedCards.length).toBe(1);

    // A late click on the now-gone entry must not throw.
    await flow.handleDecide(
      _makePayload({
        message_id: "card_exp_1",
        operator_open_id: "ou_alice",
        value: { action: "permission_decide", request_id: "x", decision: "allow" },
      }),
    );
  });

  test("verifyToken is constant-time and rejects bad tokens", () => {
    const { channel } = _makeChannel("card_msg_4");
    const flow = new PermissionFlow({
      feishuChannels: new Map([["ch_1", channel]]),
    });
    expect(flow.verifyToken(flow.apiToken)).toBe(true);
    expect(flow.verifyToken("")).toBe(false);
    expect(flow.verifyToken(flow.apiToken + "x")).toBe(false);
    expect(flow.verifyToken(null)).toBe(false);
    expect(flow.verifyToken(undefined)).toBe(false);
  });
});
