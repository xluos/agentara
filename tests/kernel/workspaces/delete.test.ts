import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Database as SQLiteDatabase } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";

import {
  groupWorkspaces,
  sessions,
  workspaces,
} from "@/kernel/sessioning/data";
import { tasks } from "@/kernel/tasking/data";
import {
  GroupWorkspaceStore,
  WorkspaceNotFoundError,
  WorkspaceProtectedError,
} from "@/kernel/workspaces";
import { config } from "@/shared";

let homeDir: string;
let store: GroupWorkspaceStore;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- drizzle schema typing is not worth narrowing for tests.
let db: any;

function freshDb(): ReturnType<typeof drizzle> {
  const sqlite = new SQLiteDatabase(":memory:");
  sqlite.run("PRAGMA foreign_keys = ON");
  const instance = drizzle(sqlite, {
    schema: { workspaces, groupWorkspaces, sessions, tasks },
  });
  migrate(instance, { migrationsFolder: join(import.meta.dir, "..", "..", "..", "drizzle") });
  return instance;
}

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), "agentara-delete-ws-test-"));
  // GroupWorkspaceStore.ensureBaseDirs writes under config.paths.workspaces —
  // point it at the temp home so the test doesn't touch the real ~/.agentara.
  process.env.AGENTARA_HOME = homeDir;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- config.paths is lazily derived from env at boot; tests reach in.
  (config as any).paths = {
    ...config.paths,
    home: homeDir,
    workspaces: join(homeDir, "workspaces"),
    default_workspace: join(homeDir, "workspaces", "_default"),
    resolveWorkspacePathById: (id: string) =>
      join(homeDir, "workspaces", id),
    resolveDataFilePath: (name: string) => join(homeDir, "data", name),
  };
  mkdirSync(join(homeDir, "workspaces", "_default"), { recursive: true });
  db = freshDb();
  store = new GroupWorkspaceStore(db);
});

afterEach(() => {
  rmSync(homeDir, { recursive: true, force: true });
});

describe("GroupWorkspaceStore.deleteWorkspace", () => {
  test("cascades bindings, sessions, tasks, and on-disk directory", () => {
    const binding = store.upsertBinding("oc_aaa", {
      workspace_name: "alpha",
    });
    // A second chat bound to the same workspace so we also verify shared
    // bindings are both removed.
    store.upsertBinding("oc_bbb", { workspace_id: binding.workspace_id });

    // Drop a fake file in the workspace dir so we can verify rmSync ran.
    writeFileSync(
      join(binding.workspace_path, "README.md"),
      "hello\n",
    );

    const now = Date.now();
    db.insert(sessions)
      .values([
        {
          id: "s1",
          agent_type: "claude-code",
          cwd: binding.workspace_path,
          channel_id: null,
          chat_id: "oc_aaa",
          thread_id: null,
          first_message: "",
          runner_session_id: null,
          last_message_created_at: null,
          created_at: now,
          updated_at: now,
        },
        {
          id: "s2",
          agent_type: "claude-code",
          cwd: join(binding.workspace_path, "agentara"),
          channel_id: null,
          chat_id: "oc_bbb",
          thread_id: null,
          first_message: "",
          runner_session_id: null,
          last_message_created_at: null,
          created_at: now,
          updated_at: now,
        },
        // Session in a different workspace path — must survive the delete.
        {
          id: "s3",
          agent_type: "claude-code",
          cwd: join(homeDir, "workspaces", "unrelated"),
          channel_id: null,
          chat_id: "oc_ccc",
          thread_id: null,
          first_message: "",
          runner_session_id: null,
          last_message_created_at: null,
          created_at: now,
          updated_at: now,
        },
      ])
      .run();
    db.insert(tasks)
      .values([
        {
          id: "t1",
          session_id: "s1",
          type: "inbound_message",
          status: "completed",
          payload: {},
          created_at: now,
          updated_at: now,
        },
        {
          id: "t2",
          session_id: "s3",
          type: "inbound_message",
          status: "completed",
          payload: {},
          created_at: now,
          updated_at: now,
        },
      ])
      .run();

    const result = store.deleteWorkspace(binding.workspace_id);

    expect(result.removed_bindings).toBe(2);
    expect(result.removed_sessions).toBe(2);
    expect(result.removed_tasks).toBe(1);
    expect(result.removed_directory).toBe(true);

    expect(store.getWorkspace(binding.workspace_id)).toBeNull();
    expect(store.getBinding("oc_aaa")).toBeNull();
    expect(store.getBinding("oc_bbb")).toBeNull();

    const survivingSessions = db.select().from(sessions).all();
    expect(survivingSessions.map((s: { id: string }) => s.id)).toEqual(["s3"]);
    const survivingTasks = db.select().from(tasks).all();
    expect(survivingTasks.map((t: { id: string }) => t.id)).toEqual(["t2"]);
    expect(existsSync(binding.workspace_path)).toBe(false);
  });

  test("throws WorkspaceNotFoundError for unknown ids", () => {
    expect(() => store.deleteWorkspace("ws_missing")).toThrow(
      WorkspaceNotFoundError,
    );
  });

  test("refuses to delete the default workspace directory", () => {
    const now = Date.now();
    db.insert(workspaces)
      .values({
        id: "ws_default_row",
        name: "_default",
        path: config.paths.default_workspace,
        active_repo: null,
        active_branch: null,
        created_at: now,
        updated_at: now,
        last_active_at: now,
      })
      .run();
    expect(() => store.deleteWorkspace("ws_default_row")).toThrow(
      WorkspaceProtectedError,
    );
    expect(existsSync(config.paths.default_workspace)).toBe(true);
  });
});

describe("GroupWorkspaceStore.touchLastActive", () => {
  test("updates last_active_at without mutating updated_at", () => {
    const binding = store.upsertBinding("oc_touch", {
      workspace_name: "beta",
    });
    const before = store.getWorkspace(binding.workspace_id)!;

    // Advance the clock via the optional ts arg so the test doesn't need a
    // real sleep to observe the bump.
    const later = before.last_active_at + 10_000;
    store.touchLastActive(binding.workspace_id, later);

    const after = store.getWorkspace(binding.workspace_id)!;
    expect(after.last_active_at).toBe(later);
    expect(after.updated_at).toBe(before.updated_at);
  });
});
