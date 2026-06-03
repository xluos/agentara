import nodePath from "node:path";

import { notifyServerCrash } from "@/community/feishu";
import { createLogger } from "@/shared";

/**
 * Process-external supervisor for the Agentara server.
 *
 * It spawns the real entrypoint (`index.ts`) as a child process and relaunches
 * it whenever it crashes, up to a bounded number of restarts. Because the
 * supervisor lives in its own process, it survives even hard child failures
 * (OOM, SIGKILL, segfault) and can surface a Feishu crash notification that an
 * in-process handler would miss.
 *
 * Restart budget uses a sliding window: a child that stays up longer than
 * {@link STABLE_MS} is considered healthy and resets the counter, so a service
 * that crashes once every few months never exhausts its budget. Only a tight
 * crash loop trips the give-up path.
 */

const _logger = createLogger("supervisor");

/** Project root, two levels up from `src/supervisor/`. */
const PROJECT_ROOT = nodePath.resolve(import.meta.dir, "../..");

/** Max consecutive fast crashes before auto-restart gives up. */
const MAX_RESTARTS = Number(process.env.AGENTARA_MAX_RESTARTS) || 3;

/** A child living at least this long resets the restart counter. */
const STABLE_MS = Number(process.env.AGENTARA_RESTART_STABLE_MS) || 60_000;

/** Pause between a crash and the next launch, to avoid a hot restart loop. */
const BACKOFF_MS = Number(process.env.AGENTARA_RESTART_BACKOFF_MS) || 2_000;

let _child: Bun.Subprocess | null = null;
let _shuttingDown = false;

/**
 * Forward a termination signal to the child and mark shutdown so the main loop
 * stops instead of treating the child's exit as a crash. Keeps `make down`
 * (SIGTERM to the supervisor) tearing down the whole tree cleanly.
 */
function _forwardSignal(signal: NodeJS.Signals): void {
  _shuttingDown = true;
  _logger.info({ signal }, "received signal; forwarding to child and stopping");
  _child?.kill("SIGTERM");
}

process.on("SIGINT", () => _forwardSignal("SIGINT"));
process.on("SIGTERM", () => _forwardSignal("SIGTERM"));

async function _main(): Promise<void> {
  _logger.info(
    { max_restarts: MAX_RESTARTS, stable_ms: STABLE_MS },
    "supervisor started",
  );

  let restarts = 0;
  while (!_shuttingDown) {
    const startedAt = Date.now();
    _child = Bun.spawn(["bun", "run", "index.ts"], {
      cwd: PROJECT_ROOT,
      stdio: ["inherit", "inherit", "inherit"],
      env: process.env,
    });
    const exitCode = await _child.exited;
    _child = null;

    if (_shuttingDown) {
      _logger.info("supervisor shutting down; not restarting child");
      break;
    }
    if (exitCode === 0) {
      _logger.info("child exited cleanly; supervisor stopping");
      break;
    }

    // The child exited non-zero. When `down.sh` tears down the whole tree it
    // batch-signals the child and the supervisor together; the child's exit
    // may surface here before our own SIGTERM handler runs. Yield briefly so a
    // co-delivered shutdown signal lands before we treat this as a crash —
    // otherwise we'd relaunch a child that immediately gets orphaned.
    await Bun.sleep(200);
    if (_shuttingDown) {
      _logger.info("shutdown signal arrived during child exit; not restarting");
      break;
    }

    const livedMs = Date.now() - startedAt;
    if (livedMs >= STABLE_MS) {
      // Child stayed up long enough to be healthy; earlier failures are
      // unrelated, so reset the sliding window before counting this crash.
      restarts = 0;
    }
    restarts += 1;

    if (restarts > MAX_RESTARTS) {
      _logger.error(
        { exit_code: exitCode, restarts: restarts - 1 },
        "child crashed too many times; giving up on auto-restart",
      );
      await notifyServerCrash({
        kind: "giveup",
        attempt: restarts - 1,
        max: MAX_RESTARTS,
      });
      break;
    }

    _logger.warn(
      { exit_code: exitCode, attempt: restarts, max: MAX_RESTARTS, lived_ms: livedMs },
      "child crashed; restarting",
    );
    await notifyServerCrash({
      kind: "restart",
      attempt: restarts,
      max: MAX_RESTARTS,
    });
    await Bun.sleep(BACKOFF_MS);
  }

  process.exit(0);
}

void _main();
