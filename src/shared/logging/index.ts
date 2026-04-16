import pino from "pino";

import * as paths from "../config/paths";

const VALID_LEVELS = ["trace", "debug", "info", "warn", "error"] as const;

function parseLevel(): pino.Level {
  const raw = process.env.AGENTARA_LOG_LEVEL?.toLowerCase();
  if (raw && VALID_LEVELS.includes(raw as (typeof VALID_LEVELS)[number])) {
    return raw as pino.Level;
  }
  return "info";
}

const isProd = process.env.NODE_ENV === "production";

/**
 * Dual transport: pretty-printed stdout (for dev UX) plus a per-day plain-text
 * file under `$AGENTARA_HOME/runtime-logs/YYYY-MM-DD.log`. File output is
 * always at `debug` level regardless of stdout level, so disk captures more
 * detail than the terminal when we tail back through a past session.
 * File path is resolved at startup — log rollover happens only on restart.
 */
const logFilePath = paths.resolveRuntimeLogFilePath(new Date());

const rootOptions: pino.LoggerOptions = {
  // Root level is the floor — each transport target can narrow but not widen.
  // We set root to "trace" so the file target can capture everything while the
  // stdout target still respects AGENTARA_LOG_LEVEL.
  level: "trace",
  transport: {
    targets: [
      {
        target: "pino-pretty",
        level: parseLevel(),
        options: {
          colorize: true,
          translateTime: isProd ? "SYS:MM-DD HH:MM:ss" : "SYS:HH:MM:ss",
          ignore: "hostname,pid,topic",
        },
      },
      {
        target: "pino-pretty",
        level: "debug",
        options: {
          destination: logFilePath,
          mkdir: true,
          colorize: false,
          translateTime: "SYS:yyyy-mm-dd HH:MM:ss",
          ignore: "hostname,pid",
          append: true,
        },
      },
    ],
  },
};

const rootLogger = pino(rootOptions);

/** Default logger with topic "agentara" (no topic shown in output). */
export const logger = rootLogger.child({ topic: "agentara" });

/**
 * Creates a child logger with the given topic. Use for session-scoped or
 * context-specific logging.
 *
 * @param topic - Topic string (e.g. `session-${sessionId}`).
 * @returns A Pino child logger with topic binding.
 */
export function createLogger(topic: string): pino.Logger {
  return rootLogger.child({
    topic,
    ...(topic !== "agentara" && { name: topic }),
  });
}

export type { Logger } from "pino";
