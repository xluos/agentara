import { describe, expect, test } from "bun:test";

import { buildUnknownCommandReply } from "@/kernel/commands";

describe("buildUnknownCommandReply", () => {
  test("names the offending command when parseable", () => {
    const reply = buildUnknownCommandReply("/halp");
    expect(reply.text).toContain("/halp");
    expect(reply.text).toContain("/help");
  });

  test("names the command even when args follow", () => {
    const reply = buildUnknownCommandReply("/foo bar baz");
    expect(reply.text).toContain("/foo");
  });

  test("lowercases command name in the message", () => {
    const reply = buildUnknownCommandReply("/FOO");
    expect(reply.text).toContain("/foo");
  });

  test("falls back to a format-error message for bare slash", () => {
    const reply = buildUnknownCommandReply("/");
    expect(reply.text).toContain("格式");
    expect(reply.text).not.toContain("`/`");
  });

  test("card body is populated", () => {
    const reply = buildUnknownCommandReply("/whatever");
    expect(reply.card.body.elements.length).toBeGreaterThan(1);
  });

  test("always points users to /help", () => {
    expect(buildUnknownCommandReply("/foo").text).toContain("/help");
    expect(buildUnknownCommandReply("/").text).toContain("/help");
  });
});
