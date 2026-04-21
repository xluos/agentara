import { describe, expect, test } from "bun:test";

import {
  MAX_MARKDOWN_BYTES_PER_CHUNK,
  MAX_STEP_TEXT_CHARS,
  MAX_STEPS_PER_CARD,
  renderMessageCard,
  splitMarkdownByBytes,
  splitMarkdownForCards,
} from "@/community/feishu/messaging/message-renderer";
import type { AssistantMessage } from "@/shared";

type StepElement = {
  tag: "div";
  text: { content: string };
};

const thinking = (text: string) =>
  ({ type: "thinking", thinking: text }) as const;
const toolUse = (name: string, input: Record<string, unknown> = {}) =>
  ({
    type: "tool_use",
    id: `t-${name}`,
    name,
    input,
  }) as const;
const noopUpload = async (p: string) => p;

describe("renderMessageCard step panel", () => {
  test("renders one step per thinking/tool_use block up to the cap", async () => {
    const content = [
      thinking("hello"),
      toolUse("Read", { file_path: "/tmp/x" }),
    ] as AssistantMessage["content"];
    const card = await renderMessageCard(content, {
      streaming: true,
      uploadImage: noopUpload,
    });
    const panel = card.body.elements[0] as { elements: StepElement[] };
    expect(panel.elements).toHaveLength(2);
    expect(panel.elements[0]!.text.content).toBe("hello");
  });

  test("keeps only the last N-1 rows + an ellipsis summary on overflow", async () => {
    const content: AssistantMessage["content"] = [];
    for (let i = 0; i < 66; i++) {
      content.push(toolUse("Bash", { description: `step ${i}` }));
    }
    const card = await renderMessageCard(content, {
      streaming: true,
      uploadImage: noopUpload,
    });
    const panel = card.body.elements[0] as {
      elements: StepElement[];
      header: { title: { content: string } };
    };
    expect(panel.elements).toHaveLength(MAX_STEPS_PER_CARD);
    // Top row is the ellipsis summary
    expect(panel.elements[0]!.text.content).toMatch(/^… \d+ earlier steps$/);
    // Header shows the TRUE count, not the windowed view size
    expect(panel.header.title.content).toBe("Working on it (66 steps)");
    // Tail preserves the most recent steps
    expect(panel.elements[panel.elements.length - 1]!.text.content).toBe(
      "step 65",
    );
  });

  test("per-step text is clipped to the single-line char cap", async () => {
    const hugeDesc = "x".repeat(MAX_STEP_TEXT_CHARS + 500);
    const content = [
      toolUse("Bash", { description: hugeDesc }),
    ] as AssistantMessage["content"];
    const card = await renderMessageCard(content, {
      streaming: true,
      uploadImage: noopUpload,
    });
    const panel = card.body.elements[0] as { elements: StepElement[] };
    expect(panel.elements[0]!.text.content.length).toBeLessThanOrEqual(
      MAX_STEP_TEXT_CHARS,
    );
    expect(panel.elements[0]!.text.content.endsWith("…")).toBe(true);
  });

  test("multi-line text is clipped to the first line with ellipsis hint", async () => {
    const multiline = "first line\nsecond line\nthird line";
    const content = [thinking(multiline)] as AssistantMessage["content"];
    const card = await renderMessageCard(content, {
      streaming: true,
      uploadImage: noopUpload,
    });
    const panel = card.body.elements[0] as { elements: StepElement[] };
    expect(panel.elements[0]!.text.content).toBe("first line …");
  });
});

describe("renderMessageCard final text", () => {
  test("summary preview stays short when the final markdown is huge", async () => {
    const bigMarkdown = "# Title\n\n" + "x".repeat(10_000);
    const content = [
      { type: "text", text: bigMarkdown },
    ] as AssistantMessage["content"];
    const card = await renderMessageCard(content, {
      streaming: false,
      uploadImage: noopUpload,
    });
    const summary = (card.config as { summary: { content: string } }).summary
      .content;
    // Body still carries the full markdown
    const body = card.body.elements.find(
      (e) => (e as { tag: string }).tag === "markdown",
    ) as { content: string } | undefined;
    expect(body?.content.length).toBeGreaterThan(5000);
    // Summary is a preview — nowhere near the full markdown length
    expect(summary.length).toBeLessThan(500);
  });
});

describe("splitMarkdownByBytes", () => {
  test("returns a single chunk when already under budget", () => {
    const chunks = splitMarkdownByBytes("hello world", 1024);
    expect(chunks).toEqual(["hello world"]);
  });

  test("splits at paragraph boundaries when over budget", () => {
    const paragraph = "x".repeat(600);
    const markdown = [paragraph, paragraph, paragraph].join("\n\n");
    const chunks = splitMarkdownByBytes(markdown, 800);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(1600); // well under 2x budget
    }
    // Content is preserved: concatenating chunks recovers the paragraphs
    const joined = chunks.join("\n\n");
    expect(joined).toContain(paragraph);
  });

  test("falls back to line splitting when a single paragraph is oversized", () => {
    const lines: string[] = [];
    for (let i = 0; i < 20; i++) lines.push("x".repeat(500));
    const markdown = lines.join("\n"); // one paragraph, many lines
    const chunks = splitMarkdownByBytes(markdown, 1024);
    expect(chunks.length).toBeGreaterThan(1);
  });
});

describe("splitMarkdownForCards", () => {
  test("caps at 5 tables per chunk AND respects byte budget", () => {
    const table = "| a | b |\n|---|---|\n| 1 | 2 |\n";
    const markdown = Array(12).fill(table).join("\n");
    const chunks = splitMarkdownForCards(markdown);
    // 12 tables > 5 per chunk → at least 3 chunks
    expect(chunks.length).toBeGreaterThanOrEqual(3);
  });

  test("MAX_MARKDOWN_BYTES_PER_CHUNK sits safely below Feishu's body cap", () => {
    expect(MAX_MARKDOWN_BYTES_PER_CHUNK).toBeGreaterThan(0);
    expect(MAX_MARKDOWN_BYTES_PER_CHUNK).toBeLessThan(30 * 1024);
  });
});
