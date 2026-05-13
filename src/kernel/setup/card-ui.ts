import type {
  Card,
  Color,
  CollapsiblePanel,
  Element,
  MarkdownElement,
} from "../../community/feishu/messaging/types";

type CardTone = "info" | "success" | "warning" | "danger" | "neutral";

const CARD_TONE_STYLES: Record<
  CardTone,
  {
    border: Color;
    background: Color;
  }
> = {
  info: {
    border: "wathet-200",
    background: "wathet-50",
  },
  success: {
    border: "green-200",
    background: "green-50",
  },
  warning: {
    border: "orange-200",
    background: "orange-50",
  },
  danger: {
    border: "red-200",
    background: "red-50",
  },
  neutral: {
    border: "grey-300",
    background: "grey-50",
  },
};

export function buildCardIntro(options: {
  title: string;
  subtitle?: string;
}): MarkdownElement {
  return buildMarkdown(
    options.subtitle
      ? [`**${options.title}**`, "", `<font color='grey'>${options.subtitle}</font>`].join("\n")
      : `**${options.title}**`,
  );
}

export function buildMarkdown(
  content: string,
  extra: Partial<Omit<MarkdownElement, "tag" | "content">> = {},
): MarkdownElement {
  return {
    tag: "markdown",
    content: optimizeCardMarkdown(content),
    ...extra,
  };
}

export function buildSectionPanel(options: {
  title: string;
  elements: Element[];
  expanded?: boolean;
  tone?: CardTone;
}): CollapsiblePanel {
  const tone = options.tone ?? "neutral";
  return {
    tag: "collapsible_panel",
    expanded: options.expanded ?? false,
    background_color: CARD_TONE_STYLES[tone].background,
    border: {
      color: CARD_TONE_STYLES[tone].border,
      corner_radius: "8px",
    },
    padding: "0px",
    vertical_spacing: "8px",
    header: {
      title: {
        tag: "plain_text",
        content: options.title,
        text_size: "medium",
      },
      icon: {
        tag: "standard_icon",
        token: "right_outlined",
        color: "grey",
      },
      icon_position: "right",
      icon_expanded_angle: 90,
      padding: "10px 12px 10px 12px",
      width: "fill",
    },
    elements: options.elements,
  };
}

export function buildSectionBlock(options: {
  title: string;
  lines: string[];
}): Element[] {
  return [
    buildMarkdown(`**${options.title}**`),
    buildMarkdown(options.lines.join("\n")),
  ];
}

/**
 * Card emitted when a user explicitly dismisses an interactive flow without
 * completing it. Title + subtitle only — no body line and no buttons. We
 * deliberately avoid `buildResultCard` here because it renders the summary
 * twice (once in the subtitle slot, once in the body), which read as
 * duplicated copy on small dismiss messages like "已关闭".
 */
export function buildDismissedCard(options: {
  title: string;
  summary?: string;
}): Card {
  const summary = options.summary ?? "已关闭，可重新发送原命令打开新卡片。";
  return {
    schema: "2.0",
    config: {
      streaming_mode: false,
      update_multi: true,
      width_mode: "fill",
      summary: { content: summarizeForSubtitle(summary) },
    },
    body: {
      padding: "12px 16px 16px 16px",
      vertical_spacing: "12px",
      elements: [
        buildCardIntro({
          title: options.title,
          subtitle: summary,
        }),
      ],
    },
  };
}

export function buildResultCard(options: {
  title: string;
  summary: string;
  detail?: string[];
}): Card {
  const tone = inferToneFromSummary(options.summary);
  const elements: Element[] = [
    buildCardIntro({
      title: options.title,
      subtitle: summarizeForSubtitle(options.summary),
    }),
    buildMarkdown(options.summary),
  ];

  if ((options.detail?.length ?? 0) > 0) {
    if (tone !== "neutral") {
      elements.push(
        buildMarkdown(`<font color='grey'>详情</font>`, {
          text_size: "notation",
        }),
      );
    }
    elements.push(buildMarkdown(options.detail!.join("\n")));
  }

  return {
    schema: "2.0",
    config: {
      streaming_mode: false,
      update_multi: true,
      width_mode: "fill",
      summary: {
        content: summarizeForSubtitle(options.summary),
      },
    },
    body: {
      padding: "12px 16px 16px 16px",
      vertical_spacing: "12px",
      elements,
    },
  };
}

export function inferToneFromSummary(summary: string): CardTone {
  if (summary.startsWith("✅")) return "success";
  if (summary.startsWith("⏳")) return "info";
  if (summary.startsWith("⚠️") || summary.startsWith("🚫")) return "warning";
  if (summary.startsWith("❌")) return "danger";
  return "neutral";
}

function summarizeForSubtitle(summary: string): string {
  // Feishu doesn't re-parse `<at>` tags inside `<font>` wrappers, which is
  // what `buildCardIntro` uses for subtitles — leaving the tag in would
  // dump its raw `at id=...` attribute text into the card. Strip mentions
  // here so the subtitle stays plain. Also collapse the resulting double
  // spaces so it reads cleanly.
  return summary
    .replace(/<at\b[^>]*>\s*<\/at>/g, "")
    .replace(/^[^\p{L}\p{N}`]+/u, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

/**
 * Lightweight markdown normalization borrowed from the richer Feishu card
 * pipeline in `happyclaw`, trimmed to what these setup cards need.
 */
export function optimizeCardMarkdown(text: string): string {
  if (!text.trim()) return text;
  const mark = "__CARD_CODE_BLOCK__";
  const codeBlocks: string[] = [];

  let normalized = text.replace(/```[\s\S]*?```/g, (block) => {
    const idx = codeBlocks.push(block) - 1;
    return `${mark}${idx}__`;
  });

  if (/^#{1,3} /m.test(normalized)) {
    normalized = normalized.replace(/^#{2,6} (.+)$/gm, "##### $1");
    normalized = normalized.replace(/^# (.+)$/gm, "#### $1");
  }

  normalized = normalized.replace(/^([^|\n].*)\n(\|.+\|)/gm, "$1\n\n$2");
  normalized = normalized.replace(/\n{3,}/g, "\n\n");

  codeBlocks.forEach((block, idx) => {
    normalized = normalized.replace(`${mark}${idx}__`, `\n<br>\n${block}\n<br>\n`);
  });

  return normalized.trim();
}
