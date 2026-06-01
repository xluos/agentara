import { z } from "zod";

/**
 * Per-quota window snapshot for the card footer. `utilization` is a
 * percentage in the `0..100` range (mirrors the Anthropic OAuth usage
 * API). `resets_at` is an ISO timestamp, or `null` when the window has
 * no scheduled reset.
 */
export const CardFooterQuota = z.object({
  utilization: z.number(),
  resets_at: z.string().nullable(),
});
export interface CardFooterQuota extends z.infer<typeof CardFooterQuota> {}

/**
 * Stats rendered at the bottom of a finalized assistant card: how full the
 * agent's context window is right now, plus the account's rolling-quota
 * progress. Every field is optional — the card degrades gracefully when a
 * runner reports no usage or the quota lookup fails.
 */
export const CardFooterStats = z.object({
  /** Resolved model id that served the latest turn, when known. */
  model: z.string().optional(),
  /** Context-window occupancy for the latest turn. */
  context: z
    .object({
      used_tokens: z.number(),
      limit_tokens: z.number(),
    })
    .optional(),
  /** Claude's rolling 5-hour usage window. */
  five_hour: CardFooterQuota.optional(),
  /** Claude's rolling 7-day usage window. */
  seven_day: CardFooterQuota.optional(),
});
export interface CardFooterStats extends z.infer<typeof CardFooterStats> {}
