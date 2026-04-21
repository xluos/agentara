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
 * Maximum step-panel elements per card. A single Feishu container is
 * capped at 50 server-side (error 11310 `element exceeds the limit`); we
 * keep cards well under that so long runs don't get rejected. The panel
 * shows the most recent N-1 steps plus a single "… K earlier steps" row
 * pinned at the top when the true count exceeds this cap.
 */
export const MAX_STEPS_PER_CARD = 25;

/**
 * Per-step text clip length. Agent output frequently contains huge Bash
 * descriptions or multi-KB thinking traces; displayed as-is they'd push
 * the card past Feishu's 30 KB body cap on their own. Each step's text
 * is truncated to at most this many characters (first line only) so the
 * panel stays legible — the full payload is always preserved in the
 * session jsonl for post-hoc inspection.
 */
export const MAX_STEP_TEXT_CHARS = 200;

/**
 * Byte budget for a single card's markdown text block. Above this we
 * spill the overflow into follow-up text-only cards.
 *
 * Feishu's content ceiling is 30 KB. Budget breakdown on a fully
 * populated card:
 *   - card wrapper (config, body shell, headers): ~800 bytes
 *   - step panel with 25 rows, per-step text clipped to 200 chars,
 *     Chinese-filled worst case: ~8–10 KB (ASCII-heavy: ~5 KB)
 *   - markdown block (in body.elements AND a short summary preview):
 *     headroom → up to ~20 KB here
 *
 * The summary preview is intentionally short (see `_summarizeMarkdown`
 * below) so we're not double-paying the markdown bytes.
 */
export const MAX_MARKDOWN_BYTES_PER_CHUNK = 20 * 1024;

/**
 * Max summary length (characters) shown in the Feishu notification /
 * chat-list preview. Kept tiny — the full message lives in the body
 * element; duplicating the whole markdown here would double the card's
 * byte cost for no visible gain.
 */
const _SUMMARY_PREVIEW_CHARS = 180;

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
  }: {
    streaming: boolean;
    // eslint-disable-next-line no-unused-vars
    uploadImage: (path: string) => Promise<string>;
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
  // Capture the real step count *before* we drop oldest rows to fit the
  // card — the header wants to show overall progress, not the windowed
  // view size.
  const trueStepCount = stepPanel.elements.length;
  _truncateStepPanel(stepPanel);
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
      card.config!.summary.content = _summarizeMarkdown(markdownContent);
      card.body.elements.push(resultElement);
    }
  }

  if (trueStepCount > 0) {
    const stepCountText =
      trueStepCount + " " + (trueStepCount === 1 ? "step" : "steps");
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
 * Drop oldest rows from the step panel when the true step count exceeds
 * Feishu's safe container size. Keeps the most recent
 * `MAX_STEPS_PER_CARD - 1` rows and prepends a single summary row like
 * `… 42 earlier steps` so the user sees both what just happened and
 * how much came before it.
 */
function _truncateStepPanel(stepPanel: CollapsiblePanel): void {
  const total = stepPanel.elements.length;
  if (total <= MAX_STEPS_PER_CARD) return;
  const kept = MAX_STEPS_PER_CARD - 1;
  const dropped = total - kept;
  const tail = stepPanel.elements.slice(-kept);
  stepPanel.elements = [
    _renderStep(`… ${dropped} earlier steps`, "more_outlined"),
    ...tail,
  ];
}

/**
 * Build a short preview of the final markdown for `config.summary.content`
 * (Feishu notifications / chat list snippet). Keep it tight — the full
 * markdown is already in body.elements, so duplicating it here just
 * doubles the card's byte cost for no visible benefit.
 */
function _summarizeMarkdown(markdown: string): string {
  const trimmed = markdown.trim();
  if (trimmed.length === 0) return "";
  const firstLineEnd = trimmed.indexOf("\n");
  const firstLine = firstLineEnd === -1 ? trimmed : trimmed.slice(0, firstLineEnd);
  if (firstLine.length <= _SUMMARY_PREVIEW_CHARS) {
    return firstLineEnd === -1 ? firstLine : firstLine + " …";
  }
  return firstLine.slice(0, _SUMMARY_PREVIEW_CHARS - 1) + "…";
}

/**
 * Clip a step's display text so the panel stays legible even when the
 * underlying tool use carries a huge Bash command or a multi-KB thinking
 * trace. Takes the first line (up to `maxChars`) and appends an ellipsis
 * when anything was dropped.
 */
function _clipStepText(
  text: string,
  maxChars: number = MAX_STEP_TEXT_CHARS,
): string {
  const firstLineEnd = text.indexOf("\n");
  const firstLine = firstLineEnd === -1 ? text : text.slice(0, firstLineEnd);
  const hadMoreLines = firstLineEnd !== -1;
  if (firstLine.length <= maxChars) {
    return hadMoreLines ? firstLine + " …" : firstLine;
  }
  return firstLine.slice(0, maxChars - 1) + "…";
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
      content: _clipStepText(text),
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

/**
 * Split markdown into byte-bounded chunks so a single final answer
 * doesn't overflow Feishu's 30 KB card body. Splits are preferred at
 * paragraph boundaries (blank lines) to keep chunks readable; if a
 * single paragraph is itself larger than `maxBytes`, falls back to line
 * boundaries, then to a hard character slice as last resort.
 *
 * The returned chunks together reproduce the input verbatim, with
 * inter-chunk whitespace trimmed at the split points.
 */
export function splitMarkdownByBytes(
  markdown: string,
  maxBytes: number = MAX_MARKDOWN_BYTES_PER_CHUNK,
): string[] {
  if (Buffer.byteLength(markdown, "utf8") <= maxBytes) {
    return [markdown];
  }
  const chunks: string[] = [];
  let current = "";
  const flush = () => {
    if (current.trim().length > 0) chunks.push(current.trim());
    current = "";
  };
  const appendWithSeparator = (piece: string, sep: string) => {
    const combined = current ? current + sep + piece : piece;
    if (Buffer.byteLength(combined, "utf8") <= maxBytes) {
      current = combined;
    } else {
      flush();
      if (Buffer.byteLength(piece, "utf8") <= maxBytes) {
        current = piece;
      } else {
        // Piece itself is oversized — emit as-is so no content is lost.
        // Callers should expect this chunk to be over budget; downstream
        // Feishu may still reject it, but that's a degenerate case worth
        // surfacing as-is rather than silently dropping.
        chunks.push(piece);
        current = "";
      }
    }
  };

  const paragraphs = markdown.split(/\n\s*\n/);
  for (const para of paragraphs) {
    if (Buffer.byteLength(para, "utf8") <= maxBytes) {
      appendWithSeparator(para, "\n\n");
      continue;
    }
    // Paragraph itself too big — fall back to splitting by line.
    flush();
    const lines = para.split("\n");
    for (const line of lines) {
      appendWithSeparator(line, "\n");
    }
  }
  flush();
  return chunks;
}

/**
 * Compose markdown splitters: first enforce the table-per-card cap
 * (Feishu renders at most 5 table components), then enforce the byte
 * cap per chunk. Result is a flat list of markdown strings each
 * individually safe to put on a single Feishu card.
 */
export function splitMarkdownForCards(
  markdown: string,
  {
    maxTables = 5,
    maxBytes = MAX_MARKDOWN_BYTES_PER_CHUNK,
  }: { maxTables?: number; maxBytes?: number } = {},
): string[] {
  const tableChunks = splitMarkdownByTables(markdown, maxTables);
  const out: string[] = [];
  for (const chunk of tableChunks) {
    out.push(...splitMarkdownByBytes(chunk, maxBytes));
  }
  return out;
}
