import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  cachedMirrorPath,
  ensureCachedMirror,
  refreshCachedMirror,
} from "@/kernel/workspaces";

/**
 * Initialize a minimal local git repo we can use as a clone source.
 * Runs synchronously so individual tests can rely on it being ready.
 */
function _initSourceRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "agentara-test-src-"));
  const run = (args: string[]) => {
    const p = Bun.spawnSync(["git", ...args], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (p.exitCode !== 0) {
      throw new Error(
        `git ${args.join(" ")} failed: ${p.stderr.toString()}`,
      );
    }
  };
  run(["init", "--initial-branch=main"]);
  run(["config", "user.email", "test@example.com"]);
  run(["config", "user.name", "Test"]);
  run(["config", "commit.gpgsign", "false"]);
  writeFileSync(join(dir, "README.md"), "hello\n");
  run(["add", "."]);
  run(["commit", "-m", "initial"]);
  return dir;
}

describe("cachedMirrorPath", () => {
  test("joins cacheRoot with <name>.git", () => {
    expect(cachedMirrorPath("foo", { cacheRoot: "/tmp/cache" })).toBe(
      "/tmp/cache/foo.git",
    );
  });
});

describe("ensureCachedMirror", () => {
  let cacheRoot: string;
  let sourceRepo: string;

  beforeAll(() => {
    cacheRoot = mkdtempSync(join(tmpdir(), "agentara-test-cache-"));
    sourceRepo = _initSourceRepo();
  });

  afterAll(() => {
    rmSync(cacheRoot, { recursive: true, force: true });
    rmSync(sourceRepo, { recursive: true, force: true });
  });

  test("clones a bare mirror when absent", async () => {
    const mirror = await ensureCachedMirror(
      { name: "repo1", git_url: sourceRepo },
      { cacheRoot },
    );
    expect(mirror).toBe(join(cacheRoot, "repo1.git"));
    // Bare repo layout: HEAD / config / objects at the top level,
    // no worktree and no `.git` subdir.
    expect(existsSync(join(mirror!, "HEAD"))).toBe(true);
    expect(existsSync(join(mirror!, "objects"))).toBe(true);
    expect(existsSync(join(mirror!, ".git"))).toBe(false);
  });

  test("is idempotent when mirror exists", async () => {
    const first = await ensureCachedMirror(
      { name: "repo1", git_url: sourceRepo },
      { cacheRoot },
    );
    const second = await ensureCachedMirror(
      { name: "repo1", git_url: sourceRepo },
      { cacheRoot },
    );
    expect(first).toBe(second);
    expect(first).not.toBeNull();
  });

  test("returns null on clone failure and leaves no partial dir", async () => {
    const mirror = await ensureCachedMirror(
      {
        name: "badrepo",
        git_url: "/definitely-does-not-exist/nowhere.git",
      },
      { cacheRoot, timeoutMs: 10_000 },
    );
    expect(mirror).toBeNull();
    expect(existsSync(join(cacheRoot, "badrepo.git"))).toBe(false);
  });

  test("concurrent calls for the same name yield the same result", async () => {
    const name = `concurrent-${Date.now()}`;
    const [a, b] = await Promise.all([
      ensureCachedMirror({ name, git_url: sourceRepo }, { cacheRoot }),
      ensureCachedMirror({ name, git_url: sourceRepo }, { cacheRoot }),
    ]);
    expect(a).toBe(b);
    expect(a).not.toBeNull();
    expect(existsSync(join(cacheRoot, `${name}.git`))).toBe(true);
  });
});

describe("refreshCachedMirror", () => {
  let cacheRoot: string;
  let sourceRepo: string;

  beforeAll(async () => {
    cacheRoot = mkdtempSync(join(tmpdir(), "agentara-test-cache-"));
    sourceRepo = _initSourceRepo();
    await ensureCachedMirror(
      { name: "repo1", git_url: sourceRepo },
      { cacheRoot },
    );
  });

  afterAll(() => {
    rmSync(cacheRoot, { recursive: true, force: true });
    rmSync(sourceRepo, { recursive: true, force: true });
  });

  test("fetches existing mirror successfully", async () => {
    const ok = await refreshCachedMirror("repo1", { cacheRoot });
    expect(ok).toBe(true);
  });

  test("returns false when the mirror doesn't exist (no-op)", async () => {
    const ok = await refreshCachedMirror("nonexistent", { cacheRoot });
    expect(ok).toBe(false);
  });
});
