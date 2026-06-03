import { describe, expect, test } from "bun:test";

import {
  buildNewCommandRejectionReply,
  buildNewCommandUsageReply,
  createFreshUserMessage,
  extractNewPrompt,
  isNewCommand,
} from "@/kernel/commands";
import type { UserMessage } from "@/shared";

function _makeUserMessage(overrides: Partial<UserMessage> = {}): UserMessage {
  return {
    id: "msg_1",
    role: "user",
    session_id: "old_session",
    channel_id: "ch_1",
    chat_id: "oc_1",
    chat_type: "group",
    thread_id: undefined,
    sender_open_id: "ou_alice",
    mentions: [],
    content: [{ type: "text", text: "/new hello" }],
    ...overrides,
  };
}

describe("isNewCommand", () => {
  test("matches bare /new and /new with args", () => {
    expect(isNewCommand("/new")).toBe(true);
    expect(isNewCommand("/new hello")).toBe(true);
    expect(isNewCommand("/new multi word prompt")).toBe(true);
  });

  test("rejects slashes that only share the prefix", () => {
    expect(isNewCommand("/newz")).toBe(false);
    expect(isNewCommand("/newhello")).toBe(false);
    expect(isNewCommand("/ new")).toBe(false);
  });

  test("rejects non-/new input", () => {
    expect(isNewCommand("hello /new")).toBe(false);
    expect(isNewCommand("/")).toBe(false);
    expect(isNewCommand("")).toBe(false);
  });
});

describe("extractNewPrompt", () => {
  test("returns empty string for bare /new", () => {
    expect(extractNewPrompt("/new")).toBe("");
  });

  test("returns empty when args are only whitespace", () => {
    expect(extractNewPrompt("/new ")).toBe("");
    expect(extractNewPrompt("/new   ")).toBe("");
  });

  test("trims outer whitespace but preserves inner spacing", () => {
    expect(extractNewPrompt("/new hello world")).toBe("hello world");
    expect(extractNewPrompt("/new   hello   ")).toBe("hello");
    expect(extractNewPrompt("/new hello   world")).toBe("hello   world");
  });

  test("returns empty for inputs that are not /new", () => {
    expect(extractNewPrompt("/newz hello")).toBe("");
    expect(extractNewPrompt("hello")).toBe("");
    expect(extractNewPrompt("")).toBe("");
  });
});

describe("createFreshUserMessage", () => {
  test("overrides session_id, clears thread_id, replaces content", () => {
    const original = _makeUserMessage({
      session_id: "old_session",
      thread_id: "om_thread_1",
    });
    const fresh = createFreshUserMessage(original, "hello", "new_session");

    expect(fresh.session_id).toBe("new_session");
    expect(fresh.thread_id).toBeUndefined();
    expect(fresh.content).toEqual([{ type: "text", text: "hello" }]);
  });

  test("preserves id, channel_id, chat_id, role, chat_type, sender_open_id", () => {
    const original = _makeUserMessage();
    const fresh = createFreshUserMessage(original, "hello", "s2");

    expect(fresh.id).toBe(original.id);
    expect(fresh.channel_id).toBe(original.channel_id);
    expect(fresh.chat_id).toBe(original.chat_id);
    expect(fresh.chat_type).toBe(original.chat_type);
    expect(fresh.sender_open_id).toBe(original.sender_open_id);
    expect(fresh.role).toBe("user");
  });

  test("does not mutate the original message", () => {
    const original = _makeUserMessage({ thread_id: "om_t1" });
    const snapshot = JSON.stringify(original);
    createFreshUserMessage(original, "hello", "s2");
    expect(JSON.stringify(original)).toBe(snapshot);
  });

  test("clears thread_id even when original had none", () => {
    const original = _makeUserMessage({ thread_id: undefined });
    const fresh = createFreshUserMessage(original, "hi", "s_new");
    expect(fresh.thread_id).toBeUndefined();
    expect(fresh.session_id).toBe("s_new");
  });
});

describe("buildNewCommandRejectionReply", () => {
  test("fallback text explains main-chat constraint", () => {
    const reply = buildNewCommandRejectionReply();
    expect(reply.text).toContain("主群");
    expect(reply.text).toContain("话题");
  });

  test("card carries elements beyond just the title", () => {
    const reply = buildNewCommandRejectionReply();
    expect(reply.card.body.elements.length).toBeGreaterThan(1);
  });
});

describe("buildNewCommandUsageReply", () => {
  test("fallback text shows usage hint", () => {
    const reply = buildNewCommandUsageReply();
    expect(reply.text).toContain("/new");
  });

  test("card body is populated", () => {
    const reply = buildNewCommandUsageReply();
    expect(reply.card.body.elements.length).toBeGreaterThan(1);
  });
});
