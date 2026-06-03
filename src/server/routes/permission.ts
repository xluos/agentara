import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";

import { kernel } from "@/kernel";
import { createLogger } from "@/shared";

const _logger = createLogger("permission-routes");

/**
 * Request body posted by the MCP stdio subprocess when Claude Code
 * invokes the `approve_tool_use` tool. The subprocess forwards the
 * Claude-side payload plus the per-session context that was baked into
 * its spawn env, so the kernel can route the card to the right chat.
 */
const PermissionRequestBody = z.object({
  session_id: z.string(),
  channel_id: z.string(),
  chat_id: z.string(),
  initiator_open_id: z.string(),
  reply_to_message_id: z.string().optional(),
  tool_name: z.string(),
  tool_input: z.record(z.string(), z.unknown()),
});

/**
 * Internal-only endpoint the MCP permission subprocess long-polls
 * against. Not mounted under `/api` because it isn't part of the
 * public surface; bearer-token auth against {@link PermissionFlow.apiToken}
 * is the only gate.
 */
export const permissionRoutes = new Hono().post(
  "/request",
  zValidator("json", PermissionRequestBody),
  async (c) => {
    const authz = c.req.header("Authorization") ?? "";
    const token = authz.startsWith("Bearer ") ? authz.slice(7) : "";
    if (!kernel.permissionFlow.verifyToken(token)) {
      _logger.warn("unauthorized permission request");
      return c.json({ error: "unauthorized" }, 401);
    }
    const body = c.req.valid("json");
    const decision = await kernel.permissionFlow.request({
      session_id: body.session_id,
      channel_id: body.channel_id,
      chat_id: body.chat_id,
      initiator_open_id: body.initiator_open_id,
      reply_to_message_id: body.reply_to_message_id,
      tool_name: body.tool_name,
      tool_input: body.tool_input,
    });
    if (decision.behavior === "allow") {
      return c.json({
        behavior: "allow",
        updatedInput: decision.updated_input ?? body.tool_input,
      });
    }
    return c.json({
      behavior: "deny",
      message: decision.message ?? "Permission denied",
    });
  },
);
