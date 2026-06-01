import { Hono } from "hono";

import { queryClaudeUsage } from "@/community/anthropic";
import { createLogger } from "@/shared";

const logger = createLogger("usage");

/**
 * Usage route group. Serves Claude usage / credentials data.
 */
export const usageRoutes = new Hono().get("/claude", async (c) => {
  try {
    const usage = await queryClaudeUsage();
    return c.json({ usage });
  } catch (err) {
    logger.error({ err }, "failed to read Claude usage");
    return c.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      500,
    );
  }
});
