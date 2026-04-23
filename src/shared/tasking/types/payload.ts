import { z } from "zod";

import { UserMessage } from "../../messaging";

/**
 * Payload for an inbound user message task.
 */
export const InboundMessageTaskPayload = z.object({
  type: z.literal("inbound_message"),
  message: UserMessage,
  forceNewRunnerSession: z.boolean().optional(),
});
export interface InboundMessageTaskPayload extends z.infer<
  typeof InboundMessageTaskPayload
> {}

/**
 * Payload for a scheduled instruction task.
 * Describes "what to do" — the schedule is stored separately via {@link TaskSchedule}.
 */
export const ScheduledTaskPayload = z.object({
  type: z.literal("scheduled_task"),
  /** The instruction string sent to the agent. */
  instruction: z.string(),
});
export interface ScheduledTaskPayload extends z.infer<
  typeof ScheduledTaskPayload
> {}

/**
 * Describes "when" a scheduled task should run.
 * Either `at`/`delay` (one-shot) or `pattern`/`every` (recurring) must be provided.
 */
export const TaskSchedule = z
  .object({
    /** Epoch milliseconds for one-shot execution at a specific time. */
    at: z.number().int().positive().optional(),
    /** Delay in milliseconds before one-shot execution (converted to `at` on registration). */
    delay: z.number().int().positive().optional(),
    /** Cron expression, e.g. `"0 3 * * *"`. */
    pattern: z.string().optional(),
    /** Interval in milliseconds between executions. */
    every: z.number().int().positive().optional(),
    /** Maximum number of executions. */
    limit: z.number().int().positive().optional(),
    /** Whether to execute immediately on registration. */
    immediately: z.boolean().optional(),
    /** Internal: bunqueue job ID for one-shot delayed jobs. */
    _job_id: z.string().optional(),
  })
  .refine(
    (data) => {
      const hasOneShot = data.at !== undefined || data.delay !== undefined;
      const hasRecurring =
        data.pattern !== undefined || data.every !== undefined;
      if (hasOneShot && hasRecurring) return false;
      if (!hasOneShot && !hasRecurring) return false;
      if (hasOneShot && data.at !== undefined && data.delay !== undefined)
        return false;
      return true;
    },
    {
      message:
        "Provide exactly one: 'at' or 'delay' (one-shot) or 'pattern'/'every' (recurring); 'at' and 'delay' are mutually exclusive",
    },
  );
export interface TaskSchedule extends z.infer<typeof TaskSchedule> {}

/**
 * Discriminated union of all supported task payloads.
 */
export const TaskPayload = z.discriminatedUnion("type", [
  InboundMessageTaskPayload,
  ScheduledTaskPayload,
]);
export type TaskPayload = InboundMessageTaskPayload | ScheduledTaskPayload;
