/**
 * Standalone stdio MCP server spawned by Claude Code as the
 * `--permission-prompt-tool` backend.
 *
 * The Claude CLI invokes `approve_tool_use` before running any tool
 * that would normally need interactive approval. This server:
 *
 * 1. Receives the JSON-RPC `tools/call` request on stdin.
 * 2. Forwards it (plus the per-session context baked into the spawn
 *    env) to the kernel's `/internal/permission/request` endpoint.
 * 3. Blocks on the kernel's long-poll response (the kernel sends an
 *    approve/deny card to Feishu and waits up to 5 min).
 * 4. Returns the decision as a single `text` content block in the
 *    shape Claude expects:
 *      `{"behavior":"allow","updatedInput":{…}}`
 *      or
 *      `{"behavior":"deny","message":"…"}`.
 *
 * This file is intentionally self-contained — it runs in its own
 * subprocess launched by Claude, not inside the kernel's runtime.
 * Do NOT import from `@/...` here; the import alias is not resolved
 * for ad-hoc `bun run <file>` subprocess invocations spawned via
 * `.mcp.json`.
 */

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const PROTOCOL_VERSION = "2024-11-05";
const TOOL_NAME = "approve_tool_use";

function _env(key: string, required = true): string {
  const v = process.env[key];
  if ((!v || v.length === 0) && required) {
    _writeToStderr(`[permission-mcp] missing required env: ${key}`);
    process.exit(1);
  }
  return v ?? "";
}

function _writeToStderr(line: string): void {
  try {
    process.stderr.write(line + "\n");
  } catch {
    // ignore
  }
}

function _writeResponse(resp: JsonRpcResponse): void {
  process.stdout.write(JSON.stringify(resp) + "\n");
}

function _buildInitializeResult(): Record<string, unknown> {
  return {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {
      tools: {},
    },
    serverInfo: {
      name: "agentara-permission",
      version: "0.1.0",
    },
  };
}

function _buildToolsListResult(): Record<string, unknown> {
  return {
    tools: [
      {
        name: TOOL_NAME,
        description:
          "Approve or deny a Claude Code tool use by forwarding the request " +
          "to the agentara kernel, which asks the human via a Feishu card.",
        inputSchema: {
          type: "object",
          properties: {
            tool_name: { type: "string" },
            input: { type: "object", additionalProperties: true },
            tool_use_id: { type: "string" },
          },
          required: ["tool_name", "input"],
          additionalProperties: true,
        },
      },
    ],
  };
}

async function _handleToolsCall(
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const toolName =
    typeof args.tool_name === "string" ? args.tool_name : "(unknown)";
  const toolInput =
    args.input && typeof args.input === "object"
      ? (args.input as Record<string, unknown>)
      : {};

  const approvalUrl = _env("AGENTARA_APPROVAL_URL");
  const approvalToken = _env("AGENTARA_APPROVAL_TOKEN");
  const body = {
    session_id: _env("AGENTARA_SESSION_ID"),
    channel_id: _env("AGENTARA_CHANNEL_ID"),
    chat_id: _env("AGENTARA_CHAT_ID"),
    initiator_open_id: _env("AGENTARA_INITIATOR_OPEN_ID"),
    reply_to_message_id: _env("AGENTARA_REPLY_TO_MESSAGE_ID", false) || undefined,
    tool_use_id:
      typeof args.tool_use_id === "string" ? args.tool_use_id : undefined,
    tool_name: toolName,
    tool_input: toolInput,
  };

  let decisionText: string;
  try {
    const res = await fetch(approvalUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${approvalToken}`,
      },
      body: JSON.stringify(body),
      // Bun's fetch supports no default timeout; the kernel already
      // caps the wait at 5 min + small buffer, and the subprocess is
      // single-purpose so a stuck request just blocks this tool call.
    });
    if (!res.ok) {
      throw new Error(`kernel returned HTTP ${res.status}`);
    }
    // We pass the kernel's JSON body through verbatim as the Claude
    // permission tool's text content — the shape already matches
    // `{behavior, updatedInput|message}`.
    decisionText = await res.text();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    _writeToStderr(`[permission-mcp] kernel call failed: ${message}`);
    decisionText = JSON.stringify({
      behavior: "deny",
      message: `Permission bridge failed: ${message}`,
    });
  }

  return {
    content: [{ type: "text", text: decisionText }],
  };
}

async function _handleRequest(req: JsonRpcRequest): Promise<void> {
  const id = req.id ?? null;
  try {
    switch (req.method) {
      case "initialize":
        _writeResponse({ jsonrpc: "2.0", id, result: _buildInitializeResult() });
        return;
      case "notifications/initialized":
        // Notifications have no id and no response.
        return;
      case "tools/list":
        _writeResponse({ jsonrpc: "2.0", id, result: _buildToolsListResult() });
        return;
      case "tools/call": {
        const params = (req.params ?? {}) as {
          name?: string;
          arguments?: Record<string, unknown>;
        };
        if (params.name !== TOOL_NAME) {
          _writeResponse({
            jsonrpc: "2.0",
            id,
            error: {
              code: -32601,
              message: `unknown tool: ${String(params.name)}`,
            },
          });
          return;
        }
        const result = await _handleToolsCall(params.arguments ?? {});
        _writeResponse({ jsonrpc: "2.0", id, result });
        return;
      }
      case "ping":
        _writeResponse({ jsonrpc: "2.0", id, result: {} });
        return;
      default:
        if (req.id !== undefined && req.id !== null) {
          _writeResponse({
            jsonrpc: "2.0",
            id,
            error: { code: -32601, message: `method not found: ${req.method}` },
          });
        }
        return;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    _writeToStderr(`[permission-mcp] handler error: ${message}`);
    if (req.id !== undefined && req.id !== null) {
      _writeResponse({
        jsonrpc: "2.0",
        id,
        error: { code: -32603, message },
      });
    }
  }
}

async function _main(): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of process.stdin as unknown as AsyncIterable<Buffer>) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      let parsed: JsonRpcRequest;
      try {
        parsed = JSON.parse(line) as JsonRpcRequest;
      } catch {
        _writeToStderr(`[permission-mcp] malformed line: ${line.slice(0, 200)}`);
        continue;
      }
      await _handleRequest(parsed);
    }
  }
}

void _main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  _writeToStderr(`[permission-mcp] fatal: ${message}`);
  process.exit(1);
});
