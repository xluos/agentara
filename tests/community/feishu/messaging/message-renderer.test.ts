import { describe, expect, test } from "bun:test";

import {
  MAX_STEPS_PER_CARD,
  renderMessageCard,
} from "@/community/feishu/messaging/message-renderer";

function countElements(value: unknown): number {
  if (!value || typeof value !== "object") {
    return 0;
  }

  const item = value as Record<string, unknown>;
  const self = typeof item.tag === "string" ? 1 : 0;
  return Object.values(item).reduce<number>(
    (count, child) =>
      count +
      (Array.isArray(child)
        ? child.reduce<number>((sum, entry) => sum + countElements(entry), 0)
        : countElements(child)),
    self,
  );
}

describe("renderMessageCard", () => {
  test("keeps final cards within Feishu's official 200 element limit", async () => {
    const card = await renderMessageCard(
      [
        ...Array.from({ length: 100 }, (_, i) => ({
          type: "tool_use" as const,
          id: `tool-${i}`,
          name: "Bash",
          input: { command: `echo ${i}` },
        })),
        { type: "text", text: "done" } as const,
      ],
      {
        streaming: false,
        uploadImage: async () => "image-key",
      },
    );

    const stepPanel = card.body.elements.find(
      (element) => element.tag === "collapsible_panel",
    );

    expect(countElements(card)).toBeLessThanOrEqual(200);
    expect(stepPanel?.tag).toBe("collapsible_panel");
    expect(stepPanel?.elements.length).toBe(MAX_STEPS_PER_CARD);
  });
});
