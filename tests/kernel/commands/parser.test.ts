import { describe, expect, test } from "bun:test";

import { parseCommand } from "@/kernel/commands";

describe("parseCommand", () => {
  test("parses a bare command", () => {
    expect(parseCommand("/ls")).toEqual({
      name: "ls",
      args: [],
      raw: "/ls",
    });
  });

  test("parses a command with args", () => {
    expect(parseCommand("/bind ws_123")).toEqual({
      name: "bind",
      args: ["ws_123"],
      raw: "/bind ws_123",
    });
  });

  test("lowercases the command name but preserves arg case", () => {
    expect(parseCommand("/STATUS WS_123")).toMatchObject({
      name: "status",
      args: ["WS_123"],
    });
  });

  test("splits args on whitespace runs", () => {
    expect(parseCommand("/clone   url   alias")).toMatchObject({
      args: ["url", "alias"],
    });
  });

  test("trims outer whitespace", () => {
    expect(parseCommand("  /ls  ")).toMatchObject({ name: "ls" });
  });

  test("returns null for non-slash input", () => {
    expect(parseCommand("hello")).toBeNull();
    expect(parseCommand("")).toBeNull();
    expect(parseCommand("  ")).toBeNull();
  });

  test("returns null for bare slash", () => {
    expect(parseCommand("/")).toBeNull();
    expect(parseCommand(" / ")).toBeNull();
  });
});
