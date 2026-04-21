import { describe, expect, test } from "bun:test";

import {
  countStepBlocks,
  MAX_STEP_PANEL_BYTES_PER_CARD,
  MAX_STEPS_PER_CARD,
  splitMessageContentForCards,
} from "@/community/feishu/messaging/message-renderer";
import type { AssistantMessage } from "@/shared";

const thinking = (text: string) =>
  ({ type: "thinking", thinking: text }) as const;
const toolUse = (name: string, input: Record<string, unknown> = {}) =>
  ({
    type: "tool_use",
    id: `t-${name}`,
    name,
    input,
  }) as const;
const textBlock = (text: string) => ({ type: "text" as const, text });

describe("splitMessageContentForCards", () => {
  test("returns the input unchanged when under both caps", () => {
    const content = [
      thinking("a"),
      toolUse("Read"),
      textBlock("hello"),
    ] as AssistantMessage["content"];
    const chunks = splitMessageContentForCards(content);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe(content);
  });

  test("splits a 66-step panel into three chunks of 25/25/16 by step count", () => {
    const content: AssistantMessage["content"] = [];
    for (let i = 0; i < 66; i++) {
      content.push(toolUse(`tool_${i}`));
    }
    const chunks = splitMessageContentForCards(content);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toHaveLength(25);
    expect(chunks[1]).toHaveLength(25);
    expect(chunks[2]).toHaveLength(16);
    // Order preserved across chunks
    expect((chunks[0]![0] as { name: string }).name).toBe("tool_0");
    expect((chunks[1]![0] as { name: string }).name).toBe("tool_25");
    expect((chunks[2]![0] as { name: string }).name).toBe("tool_50");
  });

  test("splits by byte budget when individual steps are heavy", () => {
    // 10 KB description × 4 steps ≈ 40 KB > default 20 KB budget
    const fat = "x".repeat(10 * 1024);
    const content: AssistantMessage["content"] = [];
    for (let i = 0; i < 4; i++) {
      content.push(toolUse("Bash", { description: fat }));
    }
    const chunks = splitMessageContentForCards(content);
    // Should produce at least 2 chunks even though we're well under 25 steps
    expect(chunks.length).toBeGreaterThan(1);
    // Each chunk (except single-oversized-step chunks) should respect the budget
    for (const chunk of chunks) {
      const chunkJsonBytes = JSON.stringify(chunk).length;
      // Either the chunk is one step (unavoidably oversized) or it fits
      if (chunk.length > 1) {
        expect(chunkJsonBytes).toBeLessThanOrEqual(
          MAX_STEP_PANEL_BYTES_PER_CARD + 2 * 1024,
        );
      }
    }
  });

  test("a single oversized step still lives in its own chunk (never dropped)", () => {
    const huge = "y".repeat(30 * 1024);
    const content: AssistantMessage["content"] = [
      toolUse("Bash", { description: huge }),
      toolUse("Read"),
    ];
    const chunks = splitMessageContentForCards(content);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    // The huge step should be isolated in its own chunk
    const firstChunk = chunks[0]!;
    expect(firstChunk).toHaveLength(1);
    expect((firstChunk[0] as { name: string }).name).toBe("Bash");
  });

  test("non-step text blocks always ride on the last chunk", () => {
    const content: AssistantMessage["content"] = [];
    content.push(textBlock("opening narration"));
    for (let i = 0; i < 51; i++) {
      content.push(toolUse(`t${i}`));
    }
    content.push(textBlock("final answer"));
    const chunks = splitMessageContentForCards(content);
    expect(chunks).toHaveLength(3);
    // First two chunks: pure steps, no text
    for (const c of [chunks[0]!, chunks[1]!]) {
      for (const block of c) {
        expect(block.type).not.toBe("text");
      }
    }
    // Last chunk carries all text blocks
    const lastTexts = chunks[2]!.filter((b) => b.type === "text");
    expect(lastTexts).toHaveLength(2);
    expect((lastTexts[0] as { text: string }).text).toBe("opening narration");
    expect((lastTexts[1] as { text: string }).text).toBe("final answer");
  });

  test("returns [[]] for empty content", () => {
    const chunks = splitMessageContentForCards([]);
    // Empty content fits in a single (empty) chunk.
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toEqual([]);
  });

  test("exposed caps are within Feishu-safe bounds", () => {
    expect(MAX_STEPS_PER_CARD).toBeGreaterThan(0);
    expect(MAX_STEPS_PER_CARD).toBeLessThanOrEqual(50);
    // 30 KB is Feishu's content cap; reserved step-panel budget must leave
    // headroom for the card wrapper and the final markdown text.
    expect(MAX_STEP_PANEL_BYTES_PER_CARD).toBeLessThan(30 * 1024);
  });
});

describe("countStepBlocks", () => {
  test("counts thinking + tool_use, ignoring text", () => {
    const content = [
      thinking("a"),
      toolUse("Bash"),
      textBlock("ignore me"),
      toolUse("Read"),
    ] as AssistantMessage["content"];
    expect(countStepBlocks(content)).toBe(3);
  });

  test("returns 0 for text-only content", () => {
    const content = [
      textBlock("one"),
      textBlock("two"),
    ] as AssistantMessage["content"];
    expect(countStepBlocks(content)).toBe(0);
  });
});
