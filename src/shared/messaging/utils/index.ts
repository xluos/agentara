import type {
  BashToolUseMessageContent,
  EditToolUseMessageContent,
  GlobToolUseMessageContent,
  GrepToolUseMessageContent,
  Message,
  MessageMention,
  ReadToolUseMessageContent,
  SkillToolUseMessageContent,
  ToolSearchToolUseMessageContent,
  ToolUseMessageContent,
  WebFetchToolUseMessageContent,
  WebSearchToolUseMessageContent,
  WriteToolUseMessageContent,
} from "../types";

export function isPureTextMessage(message: Message): boolean {
  if (message.role === "user" || message.role === "assistant") {
    for (const content of message.content) {
      if (content.type !== "text") {
        return false;
      }
    }
    return true;
  }
  return false;
}

export function containsThinking(message: Message): boolean {
  if (message.role === "assistant") {
    for (const content of message.content) {
      if (content.type === "thinking") {
        return true;
      }
    }
  }
  return false;
}

export function containsToolUse(message: Message): boolean {
  if (message.role === "assistant") {
    for (const content of message.content) {
      if (content.type === "tool_use") {
        return true;
      }
    }
  }
  return false;
}

export function extractTextContent(
  message: Message,
  options: { includeToolUse?: boolean; includeThinking?: boolean } = {
    includeToolUse: false,
    includeThinking: false,
  },
): string {
  const result: string[] = [];
  if (
    message.role === "user" ||
    message.role === "assistant" ||
    message.role === "tool"
  ) {
    for (const content of message.content) {
      if (content.type === "text") {
        result.push(content.text);
      }

      if (content.type === "image_url") {
        result.push(`![](${content.image_url})`);
      }

      if (content.type === "thinking" && options.includeThinking) {
        result.push("Think> " + content.thinking);
      }

      if (content.type === "tool_use" && options.includeToolUse) {
        result.push(extractToolUse(content));
      }

      if (content.type === "tool_result" && options.includeToolUse) {
        result.push(content.content);
      }
    }
  }
  return result.join("\n\n").trim();
}

/**
 * Replace placeholder `key`s with `@<name>` for each provided mention.
 *
 * Feishu delivers @-mentions as opaque `@_user_N` tokens in the message
 * text plus a sibling `mentions` array carrying the real `open_id` and
 * `name`. Agent runners call this before serializing the prompt so the
 * underlying LLM sees `@xluos` instead of `@_user_0`. Keys without a
 * known name are left as-is.
 */
export function inlineMentions(
  text: string,
  mentions: MessageMention[] | undefined,
): string {
  if (!mentions || mentions.length === 0) return text;
  let result = text;
  for (const mention of mentions) {
    if (!mention.name) continue;
    result = result.replaceAll(mention.key, `@${mention.name}`);
  }
  return result;
}

function extractToolUse(content: ToolUseMessageContent): string {
  if (content.name === "Task") {
    const toolUse = content as ToolUseMessageContent;
    const parts = [`<Spawn Subtask> ${toolUse.input.subagent_type}`];
    if (toolUse.input.description) {
      parts.push(toolUse.input.description);
    }
    if (toolUse.input.prompt) {
      parts.push(toolUse.input.prompt);
    }
    return parts.join("\n\n");
  }
  if (content.name === "TaskStop") {
    return "<Stop Subtask>";
  } else if (content.name === "TaskOutput") {
    return "<Get Subtask Output>";
  } else if (content.name === "Bash") {
    const toolUse = content as BashToolUseMessageContent;
    const parts: string[] = [];
    if (toolUse.input.description) {
      parts.push(toolUse.input.description);
    }
    parts.push("<Bash> " + toolUse.input.command);
    return parts.join("\n\n");
  } else if (content.name === "Glob") {
    const toolUse = content as GlobToolUseMessageContent;
    return `<Search Files> ${toolUse.input.pattern}`;
  } else if (content.name === "Grep") {
    const toolUse = content as GrepToolUseMessageContent;
    return `<Search Text> ${toolUse.input.pattern} in ${toolUse.input.glob}`;
  } else if (content.name === "WebFetch") {
    const toolUse = content as WebFetchToolUseMessageContent;
    return `<Fetch Web Page> ${toolUse.input.url} with prompt: ${toolUse.input.prompt ?? ""}`;
  } else if (content.name === "WebSearch") {
    const toolUse = content as WebSearchToolUseMessageContent;
    return `<Search Web> ${toolUse.input.query}`;
  } else if (content.name === "Read") {
    const toolUse = content as ReadToolUseMessageContent;
    return `<Read File> ${toolUse.input.file_path}`;
  } else if (content.name === "Write") {
    const toolUse = content as WriteToolUseMessageContent;
    return `<Write File> ${toolUse.input.file_path}`;
  } else if (content.name === "Edit") {
    const toolUse = content as EditToolUseMessageContent;
    return `<Edit File> ${toolUse.input.file_path}`;
  } else if (content.name === "Skill") {
    const toolUse = content as SkillToolUseMessageContent;
    return `<Use Skill> ${toolUse.input.skill}`;
  } else if (content.name === "ToolSearch") {
    const toolUse = content as ToolSearchToolUseMessageContent;
    return `<Search Tools> ${toolUse.input.query}`;
  } else if (content.name === "TodoWrite") {
    return "<Update Todo List>";
  } else if (content.name === "EnterPlanMode") {
    return "<Enter Plan Mode>";
  } else if (content.name === "ExitPlanMode") {
    return "<Exit Plan Mode>";
  } else if (content.name === "NotebookEdit") {
    return "<Edit Notebook>";
  }
  const mcp_regex = /^([^_]+)__([^_]+)$/;
  const mcp_match = content.name.match(mcp_regex);
  if (mcp_match) {
    const [, mcpName, toolName] = mcp_match;
    return `Use ${mcpName} Tool: ${toolName}`;
  }
  return `<Use Tool> ${content.name}`;
}
