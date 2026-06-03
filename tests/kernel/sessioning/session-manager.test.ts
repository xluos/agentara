import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Database as SQLiteDatabase } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";

import { sessions } from "@/kernel/sessioning/data";
import { SessionManager } from "@/kernel/sessioning/session-manager";
import { config, type UserMessage } from "@/shared";

let homeDir: string;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- drizzle schema typing is not worth narrowing for tests.
let db: any;
let manager: SessionManager;

function freshDb(): ReturnType<typeof drizzle> {
  const sqlite = new SQLiteDatabase(":memory:");
  sqlite.run("PRAGMA foreign_keys = ON");
  const instance = drizzle(sqlite, { schema: { sessions } });
  migrate(instance, {
    migrationsFolder: join(import.meta.dir, "..", "..", "..", "drizzle"),
  });
  return instance;
}

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), "agentara-session-manager-test-"));
  process.env.AGENTARA_HOME = homeDir;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- config.paths is lazily derived from env at boot; tests reach in.
  (config as any).paths = {
    ...config.paths,
    home: homeDir,
    logs: join(homeDir, "logs"),
    sessions: join(homeDir, "sessions"),
    resolveSessionFilePath: (id: string) => join(homeDir, "sessions", `${id}.jsonl`),
    resolveSessionLogPath: (id: string) => join(homeDir, "logs", `${id}.log`),
  };
  mkdirSync(join(homeDir, "sessions"), { recursive: true });
  mkdirSync(join(homeDir, "logs"), { recursive: true });
  db = freshDb();
  manager = new SessionManager(db);
});

afterEach(() => {
  rmSync(homeDir, { recursive: true, force: true });
});

describe("SessionManager successful interaction timestamp", () => {
  test("does not count first message or emitted user messages as successful interaction", async () => {
    const firstMessage: UserMessage = {
      id: "m1",
      role: "user",
      session_id: "s1",
      channel_id: "ch1",
      content: [{ type: "text", text: "hello" }],
    };

    const session = await manager.createSession("s1", {
      agentType: "claude",
      cwd: homeDir,
      firstMessage,
    });

    expect(manager.getSession("s1")?.last_message_created_at).toBeNull();

    session.emit("message", firstMessage);

    expect(manager.getSession("s1")?.last_message_created_at).toBeNull();
  });

  test("updates last_message_created_at only when success is marked", async () => {
    await manager.createSession("s1", {
      agentType: "claude",
      cwd: homeDir,
    });

    expect(manager.getSession("s1")?.last_message_created_at).toBeNull();

    manager.markSuccessfulInteraction("s1");

    expect(manager.getSession("s1")?.last_message_created_at).toBeNumber();
  });
});
