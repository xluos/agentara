import type { Card, Element } from "../../community/feishu/messaging/types";
import {
  buildCardIntro,
  buildMarkdown,
  buildSectionBlock,
} from "../setup/card-ui";

type CommandCardSection = {
  title: string;
  lines: string[];
};

export function buildCommandCard(options: {
  title: string;
  lines?: string[];
  sections?: CommandCardSection[];
  summary?: string;
}): Card {
  const elements: Element[] = [
    buildCardIntro({ title: options.title }),
  ];

  if ((options.lines?.length ?? 0) > 0) {
    elements.push(buildMarkdown(options.lines!.join("\n")));
  }

  for (const section of options.sections ?? []) {
    elements.push(...buildSectionBlock({
      title: section.title,
      lines: section.lines,
    }));
  }

  return {
    schema: "2.0",
    config: {
      streaming_mode: false,
      update_multi: true,
      width_mode: "fill",
      summary: {
        content: options.summary ?? options.title,
      },
    },
    body: {
      padding: "12px 16px 16px 16px",
      vertical_spacing: "12px",
      elements,
    },
  };
}
