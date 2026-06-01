import { describe, expect, test } from "bun:test";

import { isPassthroughCommand } from "@/kernel/commands";

describe("isPassthroughCommand", () => {
  test("whitelists /compact", () => {
    expect(isPassthroughCommand("compact")).toBe(true);
  });

  test("is case-insensitive", () => {
    expect(isPassthroughCommand("COMPACT")).toBe(true);
  });

  test("rejects non-whitelisted commands", () => {
    expect(isPassthroughCommand("clear")).toBe(false);
    expect(isPassthroughCommand("context")).toBe(false);
    expect(isPassthroughCommand("halp")).toBe(false);
  });
});
