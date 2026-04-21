import fs from "node:fs";
import nodePath from "node:path";

import {
  config,
  type AssistantMessage,
  type BashToolUseMessageContent,
  type EditToolUseMessageContent,
  type GlobToolUseMessageContent,
  type GrepToolUseMessageContent,
  type ReadToolUseMessageContent,
  type SkillToolUseMessageContent,
  type ToolUseMessageContent,
  type WebFetchToolUseMessageContent,
  type WebSearchToolUseMessageContent,
  type WriteToolUseMessageContent,
} from "@/shared";

import type {
  Card,
  CollapsiblePanel,
  DivElement,
  MarkdownElement,
} from "./types";

/**
 * Maximum step-panel elements per card. A single Feishu container is capped
 * at 50 elements server-side (error 11310 `element exceeds the limit`); we
 * keep cards well under that for UX breathing room and let the channel
 * spill overflow into a follow-up card instead of truncating.
 */
export const MAX_STEPS_PER_CARD = 25;

/**
 * Per-card step-panel byte budget used by the content splitter.
 *
 * Feishu caps a card's JSON `content` field at ~30 KB. Subtract the card
 * wrapper (config/header/summary/collapsible shell ≈ 1 KB), the trailing
 * "more" indicator, and leave headroom for the final markdown text block
 * on the last card — 20 KB for step elements keeps every split chunk
 * comfortably under the hard ceiling while avoiding chopping on short
 * natural-size steps.
 */
export const MAX_STEP_PANEL_BYTES_PER_CARD = 20 * 1024;

/**
 * Render assistant message content as a Feishu interactive card.
 * @param messageContent - Array of content blocks (thinking, tool_use, text).
 * @param options - Rendering options (streaming mode).
 * @returns Feishu Card object for API payload.
 */
export async function renderMessageCard(
  messageContent: AssistantMessage["content"],
  {
    streaming,
    uploadImage,
    totalStepCount,
  }: {
    streaming: boolean;
    // eslint-disable-next-line no-unused-vars
    uploadImage: (path: string) => Promise<string>;
    /**
     * Grand total of steps across the whole card chain. When rendering a
     * chunk that is only a slice of the real step list (the channel is
     * splitting an overflowing message into multiple cards), the chunk's
     * own element count understates progress; pass the true total here so
     * the "Working on it (N steps)" header stays accurate.
     */
    totalStepCount?: number;
  },
): Promise<Card> {
  const stepPanel: CollapsiblePanel = {
    tag: "collapsible_panel",
    expanded: streaming,
    border: {
      color: "grey-300",
      corner_radius: "6px",
    },
    vertical_spacing: "2px",
    header: {
      title: {
        tag: "plain_text",
        text_color: "grey",
        text_size: "notation",
        content: "",
      },
      icon: {
        tag: "standard_icon",
        token: "right_outlined",
        color: "grey",
      },
      icon_position: "right",
      icon_expanded_angle: 90,
    },
    elements: [],
  };
  const card: Card = {
    schema: "2.0",
    config: {
      streaming_mode: true,
      enable_forward: true,
      enable_forward_interaction: true,
      update_multi: true,
      width_mode: "fill",
      summary: {
        content: "",
      },
    },
    body: {
      elements: [stepPanel],
    },
  };
  for (const content of messageContent) {
    if (content.type === "thinking") {
      stepPanel.elements.push(_renderStep(content.thinking, "robot_outlined"));
    } else if (content.type === "tool_use") {
      _renderTool(content, stepPanel);
    }
  }
  const headerStepCount = totalStepCount ?? stepPanel.elements.length;
  if (!streaming) {
    // Find the last text block (final response), not all text blocks
    const lastTextContent = messageContent.findLast((c) => c.type === "text");
    if (lastTextContent) {
      const markdownContent = await _uploadMessageResource(
        lastTextContent.text,
        {
          uploadImage,
        },
      );
      const resultElement: MarkdownElement = {
        tag: "markdown",
        content: markdownContent,
      };
      card.config!.summary.content = markdownContent;
      card.body.elements.push(resultElement);
    }
  }

  if (stepPanel.elements.length > 0) {
    const stepCountText =
      headerStepCount + " " + (headerStepCount === 1 ? "step" : "steps");
    if (streaming) {
      stepPanel.header.title.content = `Working on it (${stepCountText})`;
      card.config!.summary.content = `Working on it (${stepCountText})`;
    } else {
      stepPanel.header.title.content = `Show ${stepCountText}`;
    }
  } else {
    // No steps, remove the collapsible panel if it exists
    if (card.body.elements[0]?.tag === "collapsible_panel") {
      card.body.elements.splice(0, 1);
    }
    if (card.body.elements.length === 0) {
      card.body.elements.push({
        tag: "div",
        text: {
          tag: "plain_text",
          content: "",
        },
      });
    }
  }
  if (streaming) {
    card.body.elements.push({
      tag: "div",
      icon: {
        tag: "standard_icon",
        token: "more_outlined",
        color: "grey",
      },
    });
  }
  return card;
}

async function _uploadMessageResource(
  text: string,
  {
    uploadImage,
  }: {
    // eslint-disable-next-line no-unused-vars
    uploadImage: (path: string) => Promise<string>;
  },
): Promise<string> {
  const images = text.match(/!\[.*?\]\((.*?)\)/g);
  if (images) {
    for (const image of images) {
      let imagePath = image.match(/!\[.*?\]\((.*?)\)/)?.[1];
      if (imagePath) {
        if (imagePath.startsWith("http:") || imagePath.startsWith("https:")) {
          try {
            const response = await fetch(imagePath);
            const imageBuffer = await response.arrayBuffer();
            const imageName = imagePath.split("/").pop();
            const downloadPath = nodePath.join(
              config.paths.workspace,
              "downloads",
            );
            if (!fs.existsSync(downloadPath)) {
              fs.mkdirSync(downloadPath, { recursive: true });
            }
            if (imageName) {
              fs.writeFileSync(
                nodePath.join(downloadPath, imageName),
                Buffer.from(imageBuffer),
              );
              imagePath = nodePath.join("workspace", "downloads", imageName);
            }
          } catch {
            text = text.replaceAll(image, `[${imagePath}](${imagePath})`);
          }
        }
        if (fs.existsSync(nodePath.join(config.paths.home, imagePath))) {
          const imageKey = await uploadImage(imagePath);
          text = text.replaceAll(image, `![image](${imageKey})`);
        } else {
          text = text.replaceAll(image, "");
        }
      }
    }
  }
  return text;
}

/** Render a single tool use step into the collapsible panel. */
function _renderTool(
  content: ToolUseMessageContent,
  stepPanel: CollapsiblePanel,
) {
  switch (content.name) {
    case "Agent":
    case "Task":
      stepPanel.elements.push(_renderStep("Run sub-agent", "robot_outlined"));
      break;
    case "Bash":
      const bashContent = content as BashToolUseMessageContent;
      stepPanel.elements.push(
        _renderStep(
          bashContent.input.description ?? bashContent.input.command,
          "computer_outlined",
        ),
      );
      break;
    case "Edit":
      const editContent = content as EditToolUseMessageContent;
      stepPanel.elements.push(
        _renderStep(`Edit "${editContent.input.file_path}"`, "edit_outlined"),
      );
      break;
    case "Glob":
      const globContent = content as GlobToolUseMessageContent;
      stepPanel.elements.push(
        _renderStep(
          `Search files by pattern "${globContent.input.pattern}"`,
          "card-search_outlined",
        ),
      );
      break;
    case "Grep":
      const grepContent = content as GrepToolUseMessageContent;
      stepPanel.elements.push(
        _renderStep(
          `Search text by pattern "${grepContent.input.pattern}" in "${grepContent.input.glob}"`,
          "doc-search_outlined",
        ),
      );
      break;
    case "WebFetch":
      const webFetchContent = content as WebFetchToolUseMessageContent;
      stepPanel.elements.push(
        _renderStep(
          `Fetch web page from "${webFetchContent.input.url}"`,
          "language_outlined",
        ),
      );
      break;
    case "WebSearch":
      const webSearchContent = content as WebSearchToolUseMessageContent;
      stepPanel.elements.push(
        _renderStep(
          `Search web for "${webSearchContent.input.query}"`,
          "search_outlined",
        ),
      );
      break;
    case "Read":
      const readContent = content as ReadToolUseMessageContent;
      stepPanel.elements.push(
        _renderStep(
          `Read file "${readContent.input.file_path}"`,
          "file-link-bitable_outlined",
        ),
      );
      break;
    case "Write":
      const writeContent = content as WriteToolUseMessageContent;
      stepPanel.elements.push(
        _renderStep(
          `Write file "${writeContent.input.file_path}"`,
          "edit_outlined",
        ),
      );
      break;
    case "Skill":
      const skillContent = content as SkillToolUseMessageContent;
      stepPanel.elements.push(
        _renderStep(
          `Load skill "${skillContent.input.skill}"`,
          "file-link-mindnote_outlined",
        ),
      );
      break;
    case "ToolSearch":
      // Ignore ToolSearch for now
      //
      // const toolSearchContent = content as ToolSearchToolUseMessageContent;
      // stepPanel.elements.push(
      //   renderStep(
      //     `Search tools for "${toolSearchContent.input.query}"`,
      //     "search_outlined",
      //   ),
      // );
      break;
    default:
      stepPanel.elements.push(
        _renderStep(content.name, "setting-inter_outlined"),
      );
  }
}

/**
 * Approximate the JSON byte footprint a step-emitting block will cost
 * inside the step panel. Used purely for pre-flight splitting decisions —
 * accuracy within ±20% is enough; we just need to avoid chunks that
 * would blow past Feishu's 30 KB content cap on long Bash commands or
 * dense thinking traces.
 *
 * The 220-byte base covers the div / icon / plain_text wrapper JSON the
 * renderer stamps around each step.
 */
function _estimateStepByteCost(block: AssistantMessage["content"][number]): number {
  return JSON.stringify(block).length + 220;
}

/**
 * Split an assistant message's content across multiple cards when it has
 * too many step-emitting blocks (thinking + tool_use) — or too many
 * bytes' worth — to fit in one Feishu container. Each returned chunk is
 * itself a valid input for {@link renderMessageCard}.
 *
 * Rules:
 *  - Thinking / tool_use blocks are distributed in their original order
 *    across chunks. A chunk closes when the next step would push either
 *    its element count past `maxSteps` or its estimated rendered bytes
 *    past `maxBytes`. A single oversized step still gets its own chunk
 *    (we never drop content).
 *  - Text blocks (final answer / narration) never count toward either
 *    cap; they're all attached to the LAST chunk so the conversational
 *    reply lands on the active card, not buried mid-chain.
 *  - If content fits in a single card by both metrics, returns
 *    `[content]` unchanged.
 *
 * Returns at least one chunk — an empty input yields `[[]]`.
 */
export function splitMessageContentForCards(
  content: AssistantMessage["content"],
  {
    maxSteps = MAX_STEPS_PER_CARD,
    maxBytes = MAX_STEP_PANEL_BYTES_PER_CARD,
  }: { maxSteps?: number; maxBytes?: number } = {},
): AssistantMessage["content"][] {
  const stepBlocks = content.filter(
    (c) => c.type === "thinking" || c.type === "tool_use",
  );
  const nonStepBlocks = content.filter(
    (c) => c.type !== "thinking" && c.type !== "tool_use",
  );

  // Fast path: small enough to fit on a single card. Bytes are estimated
  // up-front so we skip walking the list when we're well under budget.
  if (stepBlocks.length <= maxSteps) {
    let totalBytes = 0;
    for (const b of stepBlocks) totalBytes += _estimateStepByteCost(b);
    if (totalBytes <= maxBytes) {
      return [content];
    }
  }

  const chunks: AssistantMessage["content"][] = [];
  let current: AssistantMessage["content"] = [];
  let currentBytes = 0;
  for (const block of stepBlocks) {
    const blockBytes = _estimateStepByteCost(block);
    const overflow =
      current.length >= maxSteps ||
      (current.length > 0 && currentBytes + blockBytes > maxBytes);
    if (overflow) {
      chunks.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(block);
    currentBytes += blockBytes;
  }
  if (current.length > 0 || chunks.length === 0) {
    chunks.push(current);
  }

  // Final answer / text narration belongs on the LAST card — a user
  // scrolling the thread expects the reply next to the "live" card, not
  // frozen in the middle of the chain.
  if (nonStepBlocks.length > 0) {
    chunks[chunks.length - 1]!.push(
      ...(nonStepBlocks as AssistantMessage["content"]),
    );
  }
  return chunks;
}

/** Count step-emitting blocks (thinking + tool_use) across content. */
export function countStepBlocks(content: AssistantMessage["content"]): number {
  let n = 0;
  for (const c of content) {
    if (c.type === "thinking" || c.type === "tool_use") {
      n++;
    }
  }
  return n;
}

/** Create a step element (icon + text) for the collapsible panel. */
function _renderStep(text: string, iconToken: string): DivElement {
  return {
    tag: "div",
    icon: {
      tag: "standard_icon",
      token: iconToken,
      color: "grey",
    },
    text: {
      tag: "plain_text",
      text_color: "grey",
      text_size: "notation",
      content: text,
    },
  };
}

/**
 * Regex pattern for matching markdown tables.
 * Matches: header row, separator row, and one or more data rows.
 */
const MARKDOWN_TABLE_REGEX =
  /^\|.+\|[ \t]*\n\|[\s:|-]+\|[ \t]*\n(?:\|.+\|[ \t]*\n?)+/gm;

/**
 * Split markdown content into multiple chunks, each containing at most a specified
 * number of tables. Used to work around Feishu's limit of 5 table components per card.
 *
 * @param markdown - The markdown content to split.
 * @param maxTables - Maximum number of tables per chunk (default: 5).
 * @returns Array of markdown strings, each with at most maxTables tables.
 */
export function splitMarkdownByTables(
  markdown: string,
  maxTables: number = 5,
): string[] {
  const tables = markdown.match(MARKDOWN_TABLE_REGEX);
  if (!tables || tables.length <= maxTables) {
    return [markdown];
  }

  // Find all table positions in the markdown
  const tablePositions: Array<{ start: number; end: number; match: string }> =
    [];
  let match: RegExpExecArray | null;
  const regex = new RegExp(MARKDOWN_TABLE_REGEX.source, "gm");
  while ((match = regex.exec(markdown)) !== null) {
    tablePositions.push({
      start: match.index,
      end: match.index + match[0].length,
      match: match[0],
    });
  }

  const chunks: string[] = [];
  let currentChunkStart = 0;
  let tablesInCurrentChunk = 0;

  for (let i = 0; i < tablePositions.length; i++) {
    const tablePos = tablePositions[i]!;
    tablesInCurrentChunk++;

    // If we've reached the max tables for this chunk, split here
    if (tablesInCurrentChunk >= maxTables && i < tablePositions.length - 1) {
      // End current chunk after this table
      const chunkEnd = tablePos.end;
      chunks.push(markdown.slice(currentChunkStart, chunkEnd).trim());

      // Start new chunk from the content after the current table
      currentChunkStart = chunkEnd;
      tablesInCurrentChunk = 0;
    }
  }

  // Add the remaining content as the last chunk
  const remainingContent = markdown.slice(currentChunkStart).trim();
  if (remainingContent) {
    chunks.push(remainingContent);
  }

  return chunks;
}
