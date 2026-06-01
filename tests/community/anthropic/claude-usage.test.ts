import { describe, expect, test } from "bun:test";

import { contextLimitForModel } from "@/community/anthropic";

describe("contextLimitForModel", () => {
  test("defaults to the 1M long-context window", () => {
    expect(contextLimitForModel(undefined)).toBe(1_000_000);
    expect(contextLimitForModel("claude-opus-4-7")).toBe(1_000_000);
    expect(contextLimitForModel("claude-sonnet-4-5[1m]")).toBe(1_000_000);
  });
});
