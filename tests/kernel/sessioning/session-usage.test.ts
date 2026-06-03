import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  countUsageTokens,
  readLatestSessionUsageSnapshot,
} from "@/kernel/sessioning";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agentara-session-usage-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("readLatestSessionUsageSnapshot", () => {
  test("returns the latest assistant usage from a session jsonl file", () => {
    const path = join(dir, "session.jsonl");
    writeFileSync(
      path,
      [
        JSON.stringify({
          id: "user-1",
          session_id: "s1",
          role: "user",
          content: [{ type: "text", text: "hello" }],
        }),
        JSON.stringify({
          id: "assistant-old",
          session_id: "s1",
          role: "assistant",
          content: [{ type: "text", text: "old" }],
          usage: { input_tokens: 100, output_tokens: 20 },
          model: "claude-old",
        }),
        "not json",
        JSON.stringify({
          id: "assistant-new",
          session_id: "s1",
          role: "assistant",
          content: [{ type: "text", text: "new" }],
          usage: {
            input_tokens: 150_000,
            cache_read_input_tokens: 20_000,
            cache_creation_input_tokens: 40_000,
            output_tokens: 5_000,
          },
          model: "claude-new",
        }),
      ].join("\n") + "\n",
    );

    expect(readLatestSessionUsageSnapshot("s1", path)).toEqual({
      message_id: "assistant-new",
      used_tokens: 215_000,
      model: "claude-new",
    });
  });

  test("returns undefined when no assistant usage exists", () => {
    const path = join(dir, "session.jsonl");
    writeFileSync(
      path,
      JSON.stringify({
        id: "user-1",
        session_id: "s1",
        role: "user",
        content: [{ type: "text", text: "hello" }],
      }) + "\n",
    );

    expect(readLatestSessionUsageSnapshot("s1", path)).toBeUndefined();
  });

  test("skips zero-token usage snapshots from failed turns", () => {
    const path = join(dir, "session.jsonl");
    writeFileSync(
      path,
      [
        JSON.stringify({
          id: "assistant-valid",
          session_id: "s1",
          role: "assistant",
          content: [{ type: "text", text: "valid" }],
          usage: {
            input_tokens: 400_000,
            cache_read_input_tokens: 70_000,
            output_tokens: 2_000,
          },
          model: "claude",
        }),
        JSON.stringify({
          id: "assistant-failed",
          session_id: "s1",
          role: "assistant",
          content: [{ type: "text", text: "failed" }],
          usage: {
            input_tokens: 0,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
            output_tokens: 0,
          },
          model: "claude",
        }),
      ].join("\n") + "\n",
    );

    expect(readLatestSessionUsageSnapshot("s1", path)).toEqual({
      message_id: "assistant-valid",
      used_tokens: 472_000,
      model: "claude",
    });
  });
});

describe("countUsageTokens", () => {
  test("counts prompt, cache, and output tokens", () => {
    expect(
      countUsageTokens({
        input_tokens: 1,
        cache_read_input_tokens: 2,
        cache_creation_input_tokens: 3,
        output_tokens: 4,
      }),
    ).toBe(10);
  });
});
