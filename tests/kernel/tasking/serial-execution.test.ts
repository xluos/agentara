import { join } from "node:path";

import { Database as SQLiteDatabase } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";

import { TaskDispatcher } from "@/kernel/tasking";
import { scheduledTasks, tasks } from "@/kernel/tasking/data";
import type { InboundMessageTaskPayload } from "@/shared";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- drizzle schema typing is not worth narrowing for tests.
function freshDb(): any {
  const sqlite = new SQLiteDatabase(":memory:");
  sqlite.run("PRAGMA foreign_keys = ON");
  const instance = drizzle(sqlite, { schema: { tasks, scheduledTasks } });
  migrate(instance, {
    migrationsFolder: join(import.meta.dir, "..", "..", "..", "drizzle"),
  });
  return instance;
}

function inbound(messageId: string, sessionId: string): InboundMessageTaskPayload {
  return {
    type: "inbound_message",
    message: {
      id: messageId,
      session_id: sessionId,
      role: "user",
      content: [{ type: "text", text: messageId }],
    },
  };
}

function deferred<T>() {
  return Promise.withResolvers<T>();
}

let dispatcher: TaskDispatcher | undefined;

afterEach(async () => {
  if (dispatcher) {
    await dispatcher.stop();
    dispatcher = undefined;
  }
});

describe("TaskDispatcher per-session serial execution", () => {
  test("a failed task does not poison the session queue", async () => {
    const db = freshDb();
    dispatcher = new TaskDispatcher({ db, concurrency: 1 });

    const ran: string[] = [];
    const secondRan = deferred<void>();

    dispatcher.route("inbound_message", async (_taskId, _sessionId, payload) => {
      const id = payload.message.id;
      ran.push(id);
      if (id === "msg-fail") {
        throw new Error("boom");
      }
      if (id === "msg-after") {
        secondRan.resolve();
      }
    });

    await dispatcher.start();

    const sessionId = "session-x";
    await dispatcher.dispatch(sessionId, inbound("msg-fail", sessionId));
    await dispatcher.dispatch(sessionId, inbound("msg-after", sessionId));

    // The second task must still run even though its predecessor threw.
    // Guard with a timeout so a regression surfaces as a clear failure
    // instead of a hung test.
    await Promise.race([
      secondRan.promise,
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error("second task never ran")), 4000),
      ),
    ]);

    expect(ran).toContain("msg-fail");
    expect(ran).toContain("msg-after");

    // The failure is still surfaced: the first task is recorded as failed.
    const failRow = db
      .select({ status: tasks.status })
      .from(tasks)
      .where(eq(tasks.session_id, sessionId))
      .all()
      .map((r: { status: string }) => r.status);
    expect(failRow).toContain("failed");
  });
});
