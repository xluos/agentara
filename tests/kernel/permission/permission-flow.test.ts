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
